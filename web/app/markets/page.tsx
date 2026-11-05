"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Shell } from "@/components/Shell";
import { StatusMark } from "@/components/StatusMark";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { formatPct, formatPx } from "@/lib/markets";
import { DEFAULT_WATCH, useWatchlist } from "@/lib/watchlist";
import { terminalHref } from "@/lib/symbol";
import { clock, compactUsd, globalLabel, type GlobalQuote } from "@/lib/volume";
import { deskCopy } from "@/lib/desk-copy";
import { proCopy } from "@/lib/pro-copy";

type Ticker = {
  symbol: string;
  nameZh: string;
  nameEn: string;
  category: "metal" | "crypto" | "commodity" | "fx";
  last: number;
  change: number;
  volume: string;
  venueVolumeUsd?: number;
  global?: GlobalQuote;
  priceScale: number;
  priceDecimals: number;
  regulatoryTag: string;
  status: string;
  indicative: boolean;
  halted?: boolean;
  liquidity?: "low" | "ok";
};

const CATS = ["all", "metal", "crypto", "commodity", "fx"] as const;

type SortKey = "symbol" | "last" | "change" | "volume" | "global";

export default function MarketsPage() {
  const { t, lang } = useI18n();
  const router = useRouter();
  const copy = deskCopy(lang);
  const pro = proCopy(lang);
  const [rows, setRows] = useState<Ticker[]>([]);
  const [cat, setCat] = useState<(typeof CATS)[number]>("all");
  const [view, setView] = useState<"fav" | "spot" | "gainers">("spot");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "global", dir: -1 });
  const { watch, toggle: star, replace } = useWatchlist();
  const [access, setAccess] = useState<Record<string, string>>({ metal: "allow", crypto: "pending", commodity: "pending", fx: "pending" });
  const labels: Record<(typeof CATS)[number], string> = {
    all: t.catAll, metal: t.catMetal, crypto: t.catCrypto, commodity: t.catCommodity, fx: t.catFx,
  };

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("q");
    if (q) setQuery(q);
    api<{ categories: Record<string, string> }>("/api/market/access").then((res) => setAccess(res.categories)).catch(() => undefined);
    const pull = () => api<Ticker[]>("/api/market/tickers").then(setRows).catch(() => undefined);
    pull();
    const id = window.setInterval(pull, 4000);
    return () => window.clearInterval(id);
  }, []);

  const shown = useMemo(() => {
    const filtered = rows.filter((row) => {
      if (view === "fav" && !watch.includes(row.symbol)) return false;
      if (cat !== "all" && row.category !== cat) return false;
      const name = lang === "zh" ? row.nameZh : row.nameEn;
      return `${row.symbol} ${name}`.toLowerCase().includes(query.toLowerCase());
    });
    if (view === "gainers") return [...filtered].sort((a, b) => b.change - a.change);
    const val = (row: Ticker): number | string => {
      if (sort.key === "symbol") return row.symbol;
      if (sort.key === "last") return row.last / row.priceScale;
      if (sort.key === "change") return row.change;
      if (sort.key === "volume") return row.venueVolumeUsd ?? 0;
      return row.global?.volumeUsd ?? -1;
    };
    return [...filtered].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (typeof x === "string" || typeof y === "string") return String(x).localeCompare(String(y)) * sort.dir;
      return (x - y) * sort.dir;
    });
  }, [rows, cat, query, sort, lang, view, watch]);

  const closed = (row: Ticker) => access[row.category] === "pending" || access[row.category] === "block" || row.status !== "trading";
  const head = (key: SortKey, label: string, cls = "") => (
    <th className={`sortable ${cls}${sort.key === key && view !== "gainers" ? " on" : ""}`}>
      <button type="button" onClick={() => { setView((v) => (v === "gainers" ? "spot" : v)); setSort((prev) => ({ key, dir: prev.key === key ? (prev.dir === 1 ? -1 : 1) : -1 })); }}>
        {label}{sort.key === key && view !== "gainers" ? (sort.dir === 1 ? " ↑" : " ↓") : " ↕"}
      </button>
    </th>
  );

  return (
    <Shell>
      <div className="page pro-markets">
        <div className="pm-head">
          <div>
            <h1>{t.markets}</h1>
            <p className="hint">{t.demoBook} · {rows.length}</p>
          </div>
          <nav className="pm-links">
            <Link href="/news">{lang === "en" ? "Insights" : lang === "ms" ? "Maklumat" : "行情资讯"}</Link>
            <Link href="/learn">{lang === "en" ? "Learn" : lang === "ms" ? "Belajar" : "学习中心"}</Link>
          </nav>
          <input className="search pm-search" value={query} placeholder={pro.search} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="pm-views" role="tablist">
          <button type="button" role="tab" className={view === "fav" ? "on" : ""} onClick={() => setView("fav")}>★ {pro.favorites}</button>
          <button type="button" role="tab" className={view === "spot" ? "on" : ""} onClick={() => setView("spot")}>{pro.spot}</button>
          <button type="button" role="tab" className={view === "gainers" ? "on" : ""} onClick={() => setView("gainers")}>{pro.gainers}</button>
        </div>
        <div className="pm-cats">
          {CATS.map((item) => (
            <button key={item} type="button" data-cat={item} className={cat === item ? "on" : ""} onClick={() => setCat(item)}>{labels[item]}</button>
          ))}
        </div>
        {view === "fav" && watch.length === 0 ? (
          <div className="empty-watch">
            <p>{pro.noFavorites}</p>
            <Button type="button" onClick={() => replace(DEFAULT_WATCH)}>{t.watchCta}</Button>
          </div>
        ) : null}
        <div className="panel table-wrap pm-table">
          <table className="table">
            <thead>
              <tr>
                <th className="star-col"></th>
                {head("symbol", pro.pair)}
                {head("last", pro.lastPrice, "r")}
                {head("change", pro.change24, "r")}
                {head("volume", t.venueVol, "r hide-sm")}
                {head("global", t.globalVol, "r hide-sm")}
                <th className="hide-sm">{t.regulatory}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.symbol} data-symbol={row.symbol} style={{ cursor: "pointer" }} onClick={() => router.push(terminalHref(row.symbol))}>
                  <td className="star-col"><button type="button" className={`star${watch.includes(row.symbol) ? " on" : ""}`} aria-label={row.symbol} onClick={(ev) => { ev.stopPropagation(); star(row.symbol); }}>{watch.includes(row.symbol) ? "★" : "☆"}</button></td>
                  <td>
                    <Link href={terminalHref(row.symbol)} data-symbol={row.symbol} onClick={(ev) => ev.stopPropagation()}><b>{row.symbol}</b></Link>
                    <div className="hint">{lang === "zh" ? row.nameZh : row.nameEn} · {labels[row.category]} <StatusMark halted={row.halted} pending={closed(row)} liquidity={row.liquidity} tag={row.regulatoryTag} /></div>
                    <div className="hint show-sm">{compactUsd(row.venueVolumeUsd)}</div>
                  </td>
                  <td className="num r">{formatPx(row.last / row.priceScale, row.priceDecimals)}</td>
                  <td className="r"><span className={`chg-pill ${row.change >= 0 ? "up" : "down"}`}>{formatPct(row.change)}</span></td>
                  <td className="num r hide-sm" title={t.venueTag}>{compactUsd(row.venueVolumeUsd)}</td>
                  <td className="num r global-bit hide-sm" title={`${row.global?.note ?? t.noGlobalVol} · ${row.global?.source ?? ""} · ${clock(row.global?.updatedAt)}`}>
                    {globalLabel(row.global, t.otcVolume)}
                    {row.global?.delayed ? <div className="hint">{t.dataDelayed}</div> : null}
                  </td>
                  <td className="hint hide-sm">{row.regulatoryTag}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length === 0 && !(view === "fav" && watch.length === 0) ? <p className="hint">{copy.emptyFilter}</p> : null}
          <p className="hint" style={{ marginTop: 8 }}>{t.globalHint} {t.sessionStats}</p>
        </div>
      </div>
    </Shell>
  );
}
