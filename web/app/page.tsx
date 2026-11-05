"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Num } from "@/components/Num";
import { GoldBar } from "@/components/GoldScene";

const GoldField = dynamic(() => import("@/components/GoldScene").then((mod) => mod.GoldField), { ssr: false });
import { api, connectMarket, type Book } from "@/lib/api";
import { centsToUsd, mgToGrams } from "@/lib/format";
import { LangSelect, useI18n } from "@/lib/i18n";
import { AccountSlot } from "@/components/AccountSlot";
import { WatchStrip } from "@/components/WatchStrip";
import { formatPct, formatPx } from "@/lib/markets";
import { compactUsd, type GlobalQuote } from "@/lib/volume";
import { deskCopy } from "@/lib/desk-copy";
import { liveNumber } from "@/lib/live-copy";
import { terminalHref } from "@/lib/symbol";

type Ticker = {
  symbol: string;
  nameZh: string;
  nameEn: string;
  category: string;
  last: number;
  change: number;
  high: number | null;
  low: number | null;
  rangeSource: "venue" | "reference" | null;
  priceScale: number;
  priceDecimals: number;
  volume: string;
  halted?: boolean;
  liquidity?: "low" | "ok";
  regulatoryTag?: string;
  status?: string;
  global?: GlobalQuote;
};

const SPOT = ["XAU/USD", "XAG/USD", "BTC/USD", "ETH/USD", "BRENT/USD", "EUR/USD"];

export default function Landing() {
  const { t, lang } = useI18n();
  const router = useRouter();
  const copy = deskCopy(lang);
  const [book, setBook] = useState<Book | null>(null);
  const [tickers, setTickers] = useState<Ticker[]>([]);
  const [instCount, setInstCount] = useState(0);
  const [places, setPlaces] = useState(0);

  useEffect(() => connectMarket((next) => setBook(next)), []);
  useEffect(() => {
    const pull = () => api<Ticker[]>("/api/market/tickers").then(setTickers).catch(() => undefined);
    pull();
    const id = window.setInterval(pull, 5000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    api<{ instruments: unknown[] }>("/api/market/instruments")
      .then((res) => setInstCount((res.instruments ?? []).length))
      .catch(() => undefined);
    api<{ count: number }>("/api/jurisdictions")
      .then((res) => setPlaces(res.count))
      .catch(() => undefined);
  }, []);

  const last = book?.lastPrice ?? book?.referencePrice ?? null;
  const spotlight = tickers.filter((row) => SPOT.includes(row.symbol));
  const movers = [...tickers].sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 6);
  const volume = useMemo(() => {
    const seen = new Set<string>();
    let sum = 0;
    for (const row of tickers) {
      const quote = row.global;
      if (!quote || quote.volumeUsd == null) continue;
      const key = `${quote.source}|${quote.note}|${Math.round(quote.volumeUsd)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sum += quote.volumeUsd;
    }
    return sum;
  }, [tickers]);
  const overrideVolume = liveNumber("home.statVolume");
  const overrideMarkets = liveNumber("home.statMarkets");
  const overridePlaces = liveNumber("home.statPlaces");
  const shownVolume = useCount(overrideVolume > 0 ? overrideVolume : volume);
  const shownMarkets = useCount(overrideMarkets > 0 ? overrideMarkets : instCount);
  const shownPlaces = useCount(overridePlaces > 0 ? overridePlaces : places);
  const loop = [...SPOT, ...SPOT];

  return (
    <>
      <div className="announce">{t.announcements}</div>
      <div className="stage">
        <GoldField />
        <header className="topnav">
          <Link href="/" className="brand"><span className="mark" /> MERIDEX · {t.brand}</Link>
          <nav className="home-links">
            <a href="#markets">{t.markets}</a>
            <a href="#start">{copy.pathTitle}</a>
            <Link href="/terminal">{t.trade}</Link>
            <Link href="/funds">{t.funds}</Link>
            <Link href="/news">{lang === "en" ? "Insights" : lang === "ms" ? "Maklumat" : "行情资讯"}</Link>
            <Link href="/learn">{lang === "en" ? "Learn" : lang === "ms" ? "Belajar" : "学习中心"}</Link>
          </nav>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <LangSelect />
            <AccountSlot />
          </div>
        </header>
        <div className="marquee" aria-label={t.markets}>
          <div className="marquee-track">
            {loop.map((symbol, index) => {
              const row = spotlight.find((item) => item.symbol === symbol);
              return (
                <Link key={`${symbol}-${index}`} href={terminalHref(symbol)} data-symbol={symbol} className="tick-card">
                  <header><span>{symbol}</span><span className="badge warn">{t.indicative}</span></header>
                  <b className={row && row.change >= 0 ? "up" : "down"}>{row ? formatPx(row.last / row.priceScale, row.priceDecimals) : "—"}</b>
                  <div className={`hint ${row && row.change >= 0 ? "up" : "down"}`}>{row ? formatPct(row.change) : "—"}</div>
                </Link>
              );
            })}
          </div>
        </div>
        <section className="hero">
          <div>
            <div className="kicker">{t.heroKicker}</div>
            <h1>{t.heroTitle}</h1>
            <p className="lede">{t.heroBody}</p>
            <div className="hero-actions">
              <Button size="lg" asChild><Link href="/register">{t.register}</Link></Button>
              <Button size="lg" variant="outline" asChild><Link href="/terminal">{t.ctaNow}</Link></Button>
            </div>
          </div>
          <div className="hero-visual">
            <GoldBar />
            <aside className="live-card">
              <header><span>XAU/USD</span><span>{book?.halted ? t.halted : t.open}</span></header>
              <div className="px">{last ? centsToUsd(last) : "—"}</div>
              <div className="subpx">{t.perGram} · {t.bid} {centsToUsd(book?.bids[0]?.price)} · {t.ask} {centsToUsd(book?.asks[0]?.price)}</div>
              <div className="mini-book">
                <div>
                  {(book?.asks ?? []).slice(0, 5).reverse().map((lvl) => (
                    <div key={lvl.price}><span className="ask">{centsToUsd(lvl.price)}</span><span className="num">{mgToGrams(lvl.qty)}</span></div>
                  ))}
                </div>
                <div>
                  {(book?.bids ?? []).slice(0, 5).map((lvl) => (
                    <div key={lvl.price}><span className="bid">{centsToUsd(lvl.price)}</span><span className="num">{mgToGrams(lvl.qty)}</span></div>
                  ))}
                </div>
              </div>
            </aside>
          </div>
        </section>
        <section className="counters">
          <article className="counter card">
            <span>{t.statVolume}</span>
            <b>{overrideVolume > 0 || volume ? compactUsd(shownVolume) : "—"}</b>
            <p className="hint">{t.statVolumeNote}</p>
          </article>
          <article className="counter card">
            <span>{t.statMarkets}</span>
            <b>{overrideMarkets > 0 || instCount ? Math.round(shownMarkets) : "—"}</b>
          </article>
          <article className="counter card">
            <span>{t.statPlaces}</span>
            <b>{overridePlaces > 0 || places ? Math.round(shownPlaces) : "—"}</b>
            <p className="hint">{t.statPlacesNote}</p>
          </article>
        </section>
      </div>
      <section className="section" id="watchlist">
        <h2>{t.watchlist}</h2>
        <WatchStrip rows={tickers} />
      </section>
      <section className="section" id="markets">
        <h2>{t.markets}</h2>
        <div className="panel table-wrap">
          <table className="table">
            <thead>
              <tr><th></th><th>{t.last}</th><th>{t.chg24}</th><th>{t.high24}</th><th>{t.low24}</th><th>{t.vol24}</th><th></th></tr>
            </thead>
            <tbody>
              {movers.map((row) => {
                const up = row.change >= 0;
                const name = lang === "zh" ? row.nameZh : row.nameEn;
                return (
                  <tr key={row.symbol} data-symbol={row.symbol} style={{ cursor: "pointer" }} onClick={() => router.push(terminalHref(row.symbol))}>
                    <td><Link href={terminalHref(row.symbol)} data-symbol={row.symbol}><b>{row.symbol}</b><div className="hint">{name} · {row.category} · {t.indicative}</div></Link></td>
                    <td className="num">{formatPx(row.last / row.priceScale, row.priceDecimals)}</td>
                    <td className={up ? "up" : "down"}>{formatPct(row.change)}</td>
                    <td className="num">{formatPx(row.high, row.priceDecimals)}{row.rangeSource === "reference" ? <div className="hint">{t.refTag}</div> : null}</td>
                    <td className="num">{formatPx(row.low, row.priceDecimals)}{row.rangeSource === "reference" ? <div className="hint">{t.refTag}</div> : null}</td>
                    <td className="num">{row.volume === "0" ? "—" : row.volume}</td>
                    <td></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="hint" style={{ marginTop: 8 }}>{t.indicativeNote} {t.sessionStats}</p>
        </div>
      </section>
      <section className="section" id="start">
        <h2>{copy.pathTitle}</h2>
        <div className="steps">
          <article className="step"><div className="num-label">01</div><h3>{copy.path1}</h3><p>{copy.path1b}</p><Link href="/register">{t.register}</Link></article>
          <article className="step"><div className="num-label">02</div><h3>{copy.path2}</h3><p>{copy.path2b}</p><Link href="/kyc">{t.kyc}</Link></article>
          <article className="step"><div className="num-label">03</div><h3>{copy.path3}</h3><p>{copy.path3b}</p><Link href="/funds/deposit">{copy.depositNow}</Link></article>
          <article className="step"><div className="num-label">04</div><h3>{copy.path4}</h3><p>{copy.path4b}</p><Link href="/terminal">{t.trade}</Link></article>
        </div>
      </section>
      <footer className="foot">
        <strong>MERIDEX · {t.brand}</strong>
        <span>{t.riskTitle}. {t.riskBody}</span>
        <span style={{ display: "flex", gap: 14 }}>
          <Link href="/fees">{t.feeTier}</Link>
          <Link href="/risk">{t.riskTitle}</Link>
          <Link href="/terms">{t.terms}</Link>
          <Link href="/help">{t.help}</Link>
        </span>
      </footer>
    </>
  );
}

function useCount(target: number) {
  const [value, setValue] = useState(0);
  const shown = useRef(0);
  const played = useRef(false);

  useEffect(() => {
    const apply = (next: number) => {
      shown.current = next;
      setValue(next);
    };
    if (!target) {
      apply(0);
      return;
    }
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || document.hidden || played.current) {
      played.current = true;
      apply(target);
      return;
    }
    played.current = true;
    const from = shown.current;
    const started = performance.now();
    let frame = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", onHide);
      apply(target);
    };
    const onHide = () => {
      if (document.hidden) finish();
    };
    document.addEventListener("visibilitychange", onHide);
    const tick = (now: number) => {
      if (document.hidden) {
        finish();
        return;
      }
      const p = Math.min(1, (now - started) / 800);
      apply(from + (target - from) * (1 - (1 - p) ** 3));
      if (p < 1) frame = requestAnimationFrame(tick);
      else finish();
    };
    frame = requestAnimationFrame(tick);
    return () => {
      done = true;
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [target]);

  return value;
}
