"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { SimTools } from "@/components/SimTools";
import { ProIcon } from "@/components/ProIcons";
import { api, connectMarket, type BalanceMsg } from "@/lib/api";
import { fundsCopy } from "@/lib/funds-copy";
import { formatUsd } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { formatPct, formatPx, fromScale, sparkPath, type Candle } from "@/lib/markets";
import { proCopy } from "@/lib/pro-copy";
import { canDeposit, FLOW_ASSETS } from "@/lib/wallet-flow";

type AssetRow = { asset: string; available: string; reserved: string; usd: string; qtyScale: number; qtyDecimals: number };
type Balances = { USD: { available: string; reserved: string }; assets?: AssetRow[] };
type Ticker = { symbol: string; base?: string; last: number; change: number; priceScale: number; priceDecimals: number };

// Period selector for the estimated value line. Uses existing candle data only.
const PERIODS = { "1D": { tf: "1H", limit: 24 }, "1W": { tf: "4H", limit: 42 }, "1M": { tf: "1D", limit: 30 } } as const;
type Period = keyof typeof PERIODS;

export default function FundsOverview() {
  const { lang, setLang } = useI18n();
  const copy = fundsCopy(lang);
  const pro = proCopy(lang);
  const router = useRouter();
  const [balances, setBalances] = useState<Balances | null>(null);
  const [internal, setInternal] = useState(false);
  const [fundId, setFundId] = useState("");
  const [email, setEmail] = useState("");
  const [tickers, setTickers] = useState<Ticker[]>([]);
  const [period, setPeriod] = useState<Period>("1W");
  const [series, setSeries] = useState<number[]>([]);
  const [tab, setTab] = useState<"spot" | "futures">("spot");
  const [moreOpen, setMoreOpen] = useState(false);

  function load() {
    api<Balances & { play?: boolean }>("/api/balances").then((res) => {
      setBalances(res);
      if (res.play) setInternal(true);
    }).catch(() => router.push("/login"));
    api<{ isInternalTest?: boolean; fundId?: string; email?: string }>("/api/me").then((me) => {
      setInternal(Boolean(me.isInternalTest));
      if (me.fundId) setFundId(me.fundId);
      if (me.email) setEmail(me.email);
    }).catch(() => undefined);
    api<Ticker[]>("/api/market/tickers").then(setTickers).catch(() => undefined);
  }
  useEffect(() => {
    load();
    const stop = connectMarket(() => undefined, undefined, (msg) => {
      if (msg.type === "balances") setBalances((msg as BalanceMsg).balances);
    });
    const id = window.setInterval(load, 4000);
    return () => { stop(); window.clearInterval(id); };
  }, []);

  const rows = balances?.assets ?? [];
  const total = rows.reduce((sum, row) => {
    try { return sum + BigInt(row.usd); } catch { return sum; }
  }, 0n);
  const totalUsd = Number(total) / 1_000_000;
  const tickerFor = (asset: string) => tickers.find((row) => row.symbol === `${asset}/USD`);
  const holdingsKey = rows.map((row) => `${row.asset}:${row.available}:${row.reserved}`).join("|");

  // Estimated value line: current holdings valued at past closes (cash held flat).
  useEffect(() => {
    if (!balances) return;
    let stop = false;
    const spec = PERIODS[period];
    const held = rows.filter((row) => row.asset !== "USD" && tickerFor(row.asset));
    Promise.all(held.map((row) =>
      api<{ candles: Candle[] }>(`/api/market/candles?symbol=${encodeURIComponent(`${row.asset}/USD`)}&tf=${spec.tf}&limit=${spec.limit}`)
        .then((res) => ({ row, closes: res.candles.map((c) => c.close) }))
        .catch(() => ({ row, closes: [] as number[] })),
    )).then((parts) => {
      if (stop) return;
      const len = Math.min(spec.limit, ...parts.map((p) => p.closes.length).filter((n) => n > 1), spec.limit);
      if (!parts.length || len < 2) { setSeries([]); return; }
      const out: number[] = [];
      for (let i = 0; i < len; i += 1) {
        let v = 0;
        for (const row of rows) {
          const part = parts.find((p) => p.row.asset === row.asset);
          const usdNow = Number(row.usd) / 1_000_000;
          if (!part || part.closes.length < 2) { v += usdNow; continue; }
          const qty = (Number(row.available) + Number(row.reserved)) / row.qtyScale;
          const closes = part.closes.slice(-len);
          v += qty * closes[i];
        }
        out.push(v);
      }
      out[out.length - 1] = totalUsd;
      setSeries(out);
    });
    return () => { stop = true; };
  }, [period, holdingsKey, tickers.length, Boolean(balances)]);

  const pnl = series.length > 1 ? series[series.length - 1] - series[0] : null;
  const pnlPct = pnl !== null && series[0] > 0 ? pnl / series[0] : null;
  const spark = useMemo(() => sparkPath(series, 120, 44), [series]);
  const money = (n: number) => `${n < 0 ? "-" : "+"}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div className="wallet-home">
      <div className="wh-top">
        <Link href="/account" className="wh-ico" aria-label={pro.account}><ProIcon name="grid" /></Link>
        <span className="wh-spacer" />
        <button type="button" className="wh-ico" aria-label="language" onClick={() => setLang(lang === "zh" ? "en" : lang === "en" ? "ms" : "zh")}><ProIcon name="globe" /></button>
        <button type="button" className="wh-ico" aria-label={pro.chat} onClick={() => (window as Window & { Tawk_API?: { maximize?: () => void } }).Tawk_API?.maximize?.()}><ProIcon name="chat" /></button>
      </div>
      <div className="wh-account">
        <span className="wh-avatar">{(email || "M").slice(0, 1).toUpperCase()}</span>
        <b>{email || "MERIDEX"}</b>
        {internal ? <span className="internal-badge">INTERNAL TEST / 内部测试</span> : null}
      </div>
      <section className="wh-balance">
        <div>
          <p className="wh-label">{copy.estimated} (USD)</p>
          <p className="wh-total num">{balances ? formatUsd(total) : "—"}</p>
          <p className="wh-pnl">
            {pnl === null ? <span className="hint">—</span> : <span className={pnl >= 0 ? "up" : "down"}>{money(pnl)} ({formatPct(pnlPct)})</span>}
            <span className="wh-periods">
              {(Object.keys(PERIODS) as Period[]).map((key) => (
                <button key={key} type="button" className={period === key ? "on" : ""} onClick={() => setPeriod(key)}>{key}</button>
              ))}
            </span>
          </p>
          <p className="wh-note">{pro.pnlNote}</p>
        </div>
        <svg className={`wh-spark ${pnl !== null && pnl < 0 ? "down" : "up"}`} viewBox="0 0 120 44" preserveAspectRatio="none" aria-hidden>
          {spark ? <path d={spark} /> : null}
        </svg>
      </section>
      {fundId ? <p className="hint wh-fund">{copy.fundId} <span className="num">{fundId}</span> · {copy.fundIdHint}</p> : null}
      {internal ? <p className="hint">Play money only. Deposits and withdrawals are off.</p> : (
        <div className="wh-actions">
          <Link href="/funds/deposit"><span className="ring"><ProIcon name="down" /></span>{pro.deposit}</Link>
          <Link href="/funds/withdraw"><span className="ring"><ProIcon name="up" /></span>{pro.withdraw}</Link>
          <Link href="/funds/history"><span className="ring"><ProIcon name="history" /></span>{pro.history}</Link>
          <button type="button" onClick={() => setMoreOpen((v) => !v)} aria-expanded={moreOpen}><span className="ring"><ProIcon name="more" /></span>{pro.more}</button>
        </div>
      )}
      {moreOpen ? (
        <div className="wh-more">
          <Link href="/convert">{pro.buyConvert}</Link>
          <Link href="/recurring">{pro.buyRecurring}</Link>
          <Link href="/portfolio">{pro.orders}</Link>
          <Link href="/terminal">{pro.tradeSpot}</Link>
        </div>
      ) : null}
      <div className="wh-tabs" role="tablist">
        <button type="button" role="tab" className={tab === "spot" ? "on" : ""} onClick={() => setTab("spot")}>{pro.spot}</button>
        <button type="button" role="tab" className={tab === "futures" ? "on" : ""} onClick={() => setTab("futures")}>{pro.futures}</button>
      </div>
      {tab === "spot" ? (
        <>
          <div className="wh-sum"><span>{pro.totalAssets}</span><b className="num">{balances ? formatUsd(total) : "—"}</b></div>
          {!balances ? <div className="skeleton" style={{ height: 120 }} /> : rows.length === 0 ? <p className="hint">{copy.empty}</p> : (
            <ul className="wh-list">
              {rows.map((row) => {
                const known = FLOW_ASSETS.find((item) => item.id === row.asset);
                const tk = tickerFor(row.asset);
                const qty = row.asset === "USD" ? formatUsd(BigInt(row.available) + BigInt(row.reserved)).replace("$", "") : fromScale((BigInt(row.available) + BigInt(row.reserved)).toString(), row.qtyScale, row.qtyDecimals);
                return (
                  <li key={row.asset}>
                    <span className="coin" aria-hidden>{known?.mark ?? row.asset.slice(0, 1)}</span>
                    <span className="wh-coin">
                      <b>{row.asset}</b>
                      <span className="hint">
                        {row.asset === "USD" ? "$1.00" : tk ? `$${formatPx(tk.last / tk.priceScale, tk.priceDecimals)}` : "—"}
                        {tk ? <em className={tk.change >= 0 ? "up" : "down"}> {formatPct(tk.change)}</em> : null}
                      </span>
                    </span>
                    <span className="wh-amt">
                      <b className="num">{qty}</b>
                      <span className="hint num">{formatUsd(row.usd)}</span>
                      {canDeposit(row.asset) && !internal ? (
                        <span className="row-actions">
                          <Link href={`/funds/deposit?asset=${row.asset}`}>{copy.deposit}</Link>
                          <Link href={`/funds/withdraw?asset=${row.asset}`}>{copy.withdraw}</Link>
                        </span>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : (
        <div className="wh-empty">
          <p className="hint">{pro.futuresOff}</p>
          <Link className="langbtn" href="/perps">{pro.futures}</Link>
        </div>
      )}
      <SimTools onDone={load} />
    </div>
  );
}
