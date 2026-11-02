"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Shell } from "@/components/Shell";
import { BookPanel, Tape, Ticket } from "@/components/MarketBits";
import { ReferenceDepth } from "@/components/ReferenceDepth";
import { EmptyMark } from "@/components/EmptyMark";
import { Icon } from "@/components/icons";
import { Num } from "@/components/Num";
import { PriceAlertForm } from "@/components/PriceAlertForm";
import { StatusMark } from "@/components/StatusMark";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/Toast";
import { api, connectMarket, type BalanceMsg, type Book, type Execution, type TapeTrade } from "@/lib/api";
import { setStreamTf } from "@/lib/marketBus";
import { formatUsd, timeLabel } from "@/lib/format";
import { reasonText, useI18n } from "@/lib/i18n";
import { defaultStudies, type Studies } from "@/lib/indicators";
import { TIMEFRAMES, formatPct, formatPx, fromScale, type Candle } from "@/lib/markets";
import { DEFAULT_SYMBOL, SYMBOL_STORAGE_KEY, chooseSymbol, pickerSymbols, resolveSymbol } from "@/lib/symbol";
import { useWatchlist } from "@/lib/watchlist";
import { clock, compactUsd, globalLabel, type GlobalQuote } from "@/lib/volume";
import { deskCopy } from "@/lib/desk-copy";
import { fillTemplate, formatQtyWithUnit, qtySpec, unitLabel } from "@/lib/qty";

const CandleChart = dynamic(() => import("@/components/CandleChart").then((mod) => mod.CandleChart), {
  ssr: false,
  loading: () => <div className="skeleton chart-host" />,
});

type AssetBal = { asset: string; available: string; reserved: string; usd: string; qtyScale: number; qtyDecimals: number };
type Balances = { USD: { available: string; reserved: string }; XAU: { available: string; reserved: string }; entityId: string | null; assets?: AssetBal[] };
type Order = {
  engine_order_id: string;
  symbol?: string;
  side: string;
  order_type: string;
  price_cents: string | null;
  stop_price_cents: string | null;
  qty_mg: string;
  status: string;
  reject_reason: string | null;
  created_at: string;
};
type Trade = { engine_trade_id: string; symbol?: string; price_cents: string; qty_mg: string; notional_uusd: string; fee_uusd?: string | null; userSide: string; tape_at: string };
type Inst = {
  symbol: string;
  name_zh: string;
  name_en: string;
  category: "metal" | "crypto" | "commodity" | "fx";
  base_asset: string;
  quote_asset: string;
  price_scale: string;
  qty_scale: string;
  price_decimals: number;
  qty_decimals: number;
  regulatory_tag: string;
  status: string;
};
type Ticker = {
  symbol: string;
  last: number;
  change: number;
  priceScale: number;
  priceDecimals: number;
  liquidity?: "low" | "ok";
  halted?: boolean;
  regulatoryTag?: string;
  venueVolumeUsd?: number;
  global?: GlobalQuote;
};
type DayStats = { open: number; high: number; low: number; last: number; change: number; volume: number };
type PaperState = { enabled: boolean; seedUusd: string; balances: Balances };

const CATS = ["all", "metal", "crypto", "commodity", "fx"] as const;

export default function TerminalPage() {
  const { t, lang } = useI18n();
  const copy = deskCopy(lang);
  const words = { gram: t.unitGram, kilogram: t.unitKg, ounce: t.unitOz };
  const [advanced, setAdvanced] = useState(false);
  const [showBook, setShowBook] = useState(false);
  const toast = useToast();
  const router = useRouter();
  const [book, setBook] = useState<Book | null>(null);
  const [trades, setTrades] = useState<TapeTrade[]>([]);
  const [bars, setBars] = useState<Candle[]>([]);
  const [chartState, setChartState] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [day, setDay] = useState<DayStats | null>(null);
  const [feed, setFeed] = useState<"connecting" | "live" | "down">("connecting");
  const [pane, setPane] = useState<"chart" | "book" | "tape" | "ticket">("chart");
  const [balances, setBalances] = useState<Balances | null>(null);
  const [symbol, setSymbol] = useState(DEFAULT_SYMBOL);
  const [internal, setInternal] = useState(false);
  const [query, setQuery] = useState("");
  const { watch, toggle: toggleWatch } = useWatchlist();
  const [tf, setTf] = useState<(typeof TIMEFRAMES)[number]["id"]>("1m");
  const [tab, setTab] = useState<"open" | "history" | "trades" | "balances">("open");
  const [orders, setOrders] = useState<Order[]>([]);
  const [mine, setMine] = useState<Trade[]>([]);
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState("");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [seen, setSeen] = useState<Set<string>>(new Set());
  const [list, setList] = useState<Inst[]>([]);
  const [tickers, setTickers] = useState<Ticker[]>([]);
  const [cat, setCat] = useState<(typeof CATS)[number]>("all");
  const [access, setAccess] = useState<Record<string, string>>({});
  const [volMode, setVolMode] = useState<"venue" | "global">("venue");
  const [studies, setStudies] = useState<Studies>(defaultStudies);
  const [drawMode, setDrawMode] = useState<"none" | "trend" | "hline" | "fib">("none");
  const [clearDraw, setClearDraw] = useState(0);
  const [cols, setCols] = useState({ m: 228, b: 286, t: 308 });
  const [volumes, setVolumes] = useState<(number | null)[] | null>(null);
  const [paper, setPaper] = useState(false);
  const [ordersOpen, setOrdersOpen] = useState(false);
  const [retryN, setRetryN] = useState(0);
  const [quoteLate, setQuoteLate] = useState(false);
  const paperRef = useRef(false);
  paperRef.current = paper;
  const barsRef = useRef<Candle[]>([]);
  barsRef.current = bars;
  const olderLock = useRef(false);

  const catLabel: Record<(typeof CATS)[number], string> = {
    all: t.catAll, metal: t.catMetal, crypto: t.catCrypto, commodity: t.catCommodity, fx: t.catFx,
  };

  function loadAccount(nextPaper = paper) {
    if (nextPaper) {
      api<PaperState>("/api/paper").then((res) => setBalances(res.balances)).catch(() => undefined);
      api<Order[]>("/api/paper/orders").then(setOrders).catch(() => undefined);
      api<Trade[]>("/api/paper/trades").then(setMine).catch(() => undefined);
      return;
    }
    api<Balances>("/api/balances").then(setBalances).catch(() => undefined);
    api<Order[]>("/api/orders").then(setOrders).catch(() => undefined);
    api<Trade[]>("/api/trades").then(setMine).catch(() => undefined);
  }

  useEffect(() => {
    // UI simplify: beginner (simple) view is the default; advanced only when chosen explicitly.
    const next = localStorage.getItem("meridex.advanced") === "1";
    setAdvanced(next);
    if (next) setOrdersOpen(true);
    if (!next) setPane("ticket");
  }, []);

  function setDesk(next: boolean) {
    setAdvanced(next);
    localStorage.setItem("meridex.advanced", next ? "1" : "0");
    if (!next && (pane === "book" || pane === "tape")) setPane("ticket");
    if (next) setOrdersOpen(true);
  }

  useEffect(() => {
    try {
      const saved = localStorage.getItem("meridex.studies");
      if (saved) setStudies({ ...defaultStudies, ...JSON.parse(saved) });
      const layout = localStorage.getItem("meridex.layout");
      if (layout) {
        const parsed = JSON.parse(layout) as { m?: number; b?: number; t?: number };
        if (parsed.m && parsed.b && parsed.t) setCols({ m: parsed.m, b: parsed.b, t: parsed.t });
      }
    } catch {
      /* keep defaults */
    }
  }, []);

  const symbolBoot = useRef(false);
  useLayoutEffect(() => {
    if (symbolBoot.current) return;
    symbolBoot.current = true;
    const url = new URLSearchParams(window.location.search).get("symbol");
    const stored = localStorage.getItem(SYMBOL_STORAGE_KEY);
    const choice = chooseSymbol({ url, stored }, []);
    setSymbol(choice.symbol);
    if (choice.source !== "default") localStorage.setItem(SYMBOL_STORAGE_KEY, choice.symbol);
  }, []);

  useEffect(() => {
    if (!list.length) return;
    const names = list.map((row) => row.symbol);
    setSymbol((prev) => resolveSymbol(prev, names) ?? prev);
  }, [list]);

  useEffect(() => {
    if (!localStorage.getItem("meridex.token")) router.push("/login");
    api<{ isInternalTest?: boolean }>("/api/me")
      .then((me) => {
        const test = Boolean(me.isInternalTest);
        setInternal(test);
        if (test) {
          loadAccount(false);
          return;
        }
        api<PaperState>("/api/paper")
          .then((res) => {
            setPaper(res.enabled);
            loadAccount(res.enabled);
          })
          .catch(() => loadAccount(false));
      })
      .catch(() => loadAccount(false));
    api<{ instruments: Inst[] }>("/api/market/instruments").then((res) => setList(res.instruments)).catch(() => undefined);
    api<{ categories: Record<string, string> }>("/api/market/access").then((res) => setAccess(res.categories)).catch(() => undefined);
    const onPaper = () => {
      api<PaperState>("/api/paper")
        .then((res) => {
          setPaper(res.enabled);
          loadAccount(res.enabled);
        })
        .catch(() => undefined);
    };
    window.addEventListener("meridex-paper", onPaper);
    return () => window.removeEventListener("meridex-paper", onPaper);
  }, [router]);

  async function togglePaper() {
    try {
      const res = await api<PaperState>("/api/paper", {
        method: "POST",
        body: JSON.stringify({ action: paper ? "disable" : "enable" }),
      });
      setPaper(res.enabled);
      setBalances(res.balances);
      loadAccount(res.enabled);
      window.dispatchEvent(new Event("meridex-paper"));
      toast(res.enabled ? t.paperBanner : t.realNamespace, res.enabled ? "ok" : "ok");
    } catch (err) {
      toast(reasonText(lang, (err as Error).message), "bad");
    }
  }

  async function resetPaper() {
    try {
      const res = await api<PaperState>("/api/paper", { method: "POST", body: JSON.stringify({ action: "reset" }) });
      setPaper(true);
      setBalances(res.balances);
      loadAccount(true);
      window.dispatchEvent(new Event("meridex-paper"));
      toast(t.paperReset, "ok");
    } catch (err) {
      toast(reasonText(lang, (err as Error).message), "bad");
    }
  }

  useEffect(() => {
    const pull = () => api<Ticker[]>("/api/market/tickers").then(setTickers).catch(() => undefined);
    pull();
    const id = window.setInterval(pull, 4000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    setBook(null);
    setTrades([]);
    setFeed("connecting");
    return connectMarket(
      (next, tape) => {
        if (next.symbol !== symbol) return;
        setBook(next);
        setTrades(tape);
        setPrice((prev) => prev || (next.lastPrice ? (next.lastPrice / (next.priceScale ?? 100)).toFixed(next.priceDecimals ?? 2) : ""));
      },
      setFeed,
      (msg) => {
        if (msg.type === "balances" && !paperRef.current) setBalances((msg as BalanceMsg).balances);
        if (msg.type === "execution") {
          const fill = msg as Execution;
          setSeen((prev) => {
            if (prev.has(fill.tradeId)) return prev;
            const next = new Set(prev);
            next.add(fill.tradeId);
            const inst = list.find((row) => row.symbol === (fill.symbol || symbol));
            const px = inst ? fromScale(fill.price, Number(inst.price_scale), inst.price_decimals) : String(fill.price);
            const q = inst ? fromScale(fill.qty, Number(inst.qty_scale), inst.qty_decimals) : String(fill.qty);
            toast(`${fill.symbol || symbol} ${fill.side === "buy" ? t.buy : t.sell} ${px} · ${q}`, "ok");
            return next;
          });
          loadAccount(paperRef.current);
        }
      },
      symbol,
    );
  }, [symbol, retryN]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (ev.key === "b" || ev.key === "B") setSide("buy");
      if (ev.key === "s" || ev.key === "S") setSide("sell");
      if (ev.key === "Escape") setQuery("");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const inst = list.find((row) => row.symbol === symbol);

  useEffect(() => {
    setStreamTf(tf);
    olderLock.current = false;
    let stop = false;
    setBars([]);
    setChartState("loading");
    const pull = () => {
      api<{ candles: Candle[]; stats: DayStats }>(`/api/market/candles?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)}&limit=300`)
        .then((res) => {
          if (stop) return;
          setBars(res.candles);
          setDay(res.stats);
          setChartState(res.candles.length ? "ready" : "empty");
        })
        .catch(() => { if (!stop) setChartState("error"); });
    };
    pull();
    const id = window.setInterval(pull, 30_000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [symbol, tf, retryN]);

  useEffect(() => {
    let stop = false;
    const pull = () => {
      api<{ bars: { time: number; volume: number | null }[] }>(`/api/market/volume?symbol=${encodeURIComponent(symbol)}&tf=${tf}&scope=${volMode}`)
        .then((res) => {
          if (stop) return;
          const byTime = new Map(res.bars.map((bar) => [bar.time, bar.volume]));
          setVolumes(bars.map((bar) => (byTime.has(bar.time) ? byTime.get(bar.time) ?? 0 : volMode === "venue" ? 0 : null)));
        })
        .catch(() => { if (!stop) setVolumes(null); });
    };
    pull();
    const id = window.setInterval(pull, 15000);
    return () => { stop = true; window.clearInterval(id); };
  }, [symbol, tf, volMode, bars.length, bars[0]?.time, bars[bars.length - 1]?.time]);

  useEffect(() => {
    if (book?.lastPrice == null) return;
    const px = book.lastPrice / (book.priceScale ?? 100);
    setDay((prev) => {
      if (!prev || prev.last === px) return prev;
      const high = Math.max(prev.high, px);
      const low = Math.min(prev.low, px);
      return { ...prev, last: px, high, low, change: prev.open ? (px - prev.open) / prev.open : 0 };
    });
  }, [book?.lastPrice, book?.priceScale]);

  const ps = book?.priceScale ?? 100;
  const pd = book?.priceDecimals ?? 2;
  const lastUnits = book?.lastPrice ?? book?.referencePrice ?? null;
  const shownLast = lastUnits === null ? null : lastUnits / ps;
  const gate = inst ? access[inst.category] : "allow";
  const tradable = gate === "allow" && inst?.status === "trading";

  const filtered = list.filter((row) => {
    if (cat !== "all" && row.category !== cat) return false;
    const name = lang === "zh" ? row.name_zh : row.name_en;
    return `${row.symbol} ${name} ${row.base_asset}`.toLowerCase().includes(query.toLowerCase());
  });

  useEffect(() => {
    if (book) {
      setQuoteLate(false);
      return;
    }
    setQuoteLate(false);
    const id = window.setTimeout(() => setQuoteLate(true), 2500);
    return () => window.clearTimeout(id);
  }, [symbol, retryN, book]);

  function retryQuote() {
    setChartState("loading");
    setFeed("connecting");
    setBook(null);
    setRetryN((n) => n + 1);
  }

  function pick(sym: string) {
    const next = resolveSymbol(sym, list.map((row) => row.symbol)) ?? sym;
    setSymbol(next);
    setPrice("");
    setQty("");
    localStorage.setItem(SYMBOL_STORAGE_KEY, next);
    router.replace(`/terminal?symbol=${encodeURIComponent(next)}`, { scroll: false });
  }

  async function cancel(id: string) {
    try {
      await api(paper ? `/api/paper/orders/${id}/cancel` : `/api/orders/${id}/cancel`, { method: "POST" });
      toast(t.cancel, "ok");
      loadAccount();
    } catch (err) {
      toast(reasonText(lang, (err as Error).message), "bad");
    }
  }

  async function cancelAll() {
    try {
      const res = await api<{ canceled: string[] }>(paper ? "/api/paper/orders/cancel-all" : "/api/orders/cancel-all", { method: "POST" });
      toast(`${t.cancelAll} ${res.canceled.length}`, "ok");
      loadAccount();
    } catch (err) {
      toast(reasonText(lang, (err as Error).message), "bad");
    }
  }

  async function amend(order: Order) {
    const row = list.find((item) => item.symbol === (order.symbol || "XAU/USD"));
    const nextPrice = window.prompt(t.price, order.price_cents ? fromScale(order.price_cents, Number(row?.price_scale ?? 100), row?.price_decimals ?? 2) : "");
    const unit = unitLabel(qtySpec(order.symbol || "XAU/USD"), words);
    const nextQty = window.prompt(fillTemplate(t.qtyWithUnit, { unit }), fromScale(order.qty_mg, Number(row?.qty_scale ?? qtySpec(order.symbol || "XAU/USD").scale), row?.qty_decimals ?? qtySpec(order.symbol || "XAU/USD").decimals));
    if (!nextPrice || !nextQty) return;
    try {
      await api(`/api/orders/${order.engine_order_id}/amend`, {
        method: "POST",
        body: JSON.stringify({ price: nextPrice, quantity: nextQty }),
      });
      toast(t.amend, "ok");
      loadAccount();
    } catch (err) {
      toast(reasonText(lang, (err as Error).message), "bad");
    }
  }

  const chartStudies = useMemo(
    () => (advanced ? studies : { ...studies, macd: false, rsi: false, boll: false, ema: false }),
    [advanced, studies],
  );
  const loadOlder = useCallback(() => {
    const first = barsRef.current[0]?.time;
    if (!first || olderLock.current) return;
    olderLock.current = true;
    api<{ candles: Candle[] }>(`/api/market/candles?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)}&limit=300&before=${first}`)
      .then((res) => {
        if (!res.candles.length) return;
        setBars((prev) => {
          const seen = new Set(prev.map((bar) => bar.time));
          const older = res.candles.filter((bar) => !seen.has(bar.time));
          return older.length ? [...older, ...prev] : prev;
        });
        olderLock.current = false;
      })
      .catch(() => { olderLock.current = false; });
  }, [symbol, tf]);

  const open = orders.filter((order) => order.status === "open" || order.status === "armed" || order.status === "pending");
  const history = orders.filter((order) => order.status !== "open" && order.status !== "armed" && order.status !== "pending");
  const tickerOf = (sym: string) => tickers.find((row) => row.symbol === sym);

  const ticker = tickerOf(symbol);
  const pendingBook = gate === "pending" || gate === "block";

  function toggleStudy(key: keyof Studies) {
    setStudies((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem("meridex.studies", JSON.stringify(next));
      return next;
    });
  }

  function drag(which: "m" | "b" | "t", startX: number, startW: number) {
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dir = which === "m" ? 1 : -1;
      const next = Math.max(180, Math.min(480, startW + dx * dir));
      setCols((prev) => {
        const value = { ...prev, [which]: next };
        localStorage.setItem("meridex.layout", JSON.stringify(value));
        return value;
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  return (
    <Shell>
      <div className={`term${advanced ? "" : " simple"}`} data-pane={pane} style={{ ["--col-m" as string]: `${cols.m}px`, ["--col-b" as string]: `${cols.b}px`, ["--col-t" as string]: `${cols.t}px` }}>
        <header className="panel term-top">
          {feed === "down" ? <div className="reconnect-banner">{t.feedDown}</div> : null}
          <span className={`feed-dot ${feed}`} title={feed === "down" ? t.reconnecting : t.liveWord} />
          {feed === "live" ? <em className="live-pill">{t.liveWord}</em> : null}
          <strong data-symbol={symbol}>{symbol}</strong>
          {internal ? <span className="internal-badge">INTERNAL TEST / 内部测试</span> : null}
          {true ? (
            <select className="desk-input symbol-pick" value={symbol} aria-label={t.markets} onChange={(e) => pick(e.target.value)}>
              {pickerSymbols(filtered.map((item) => item.symbol), symbol).map((sym) => <option key={sym} value={sym}>{sym}</option>)}
            </select>
          ) : null}
          <StatusMark halted={book?.halted} pending={pendingBook} liquidity={ticker?.liquidity} tag={inst?.regulatory_tag} />
          <Num value={shownLast} text={shownLast === null ? "—" : formatPx(shownLast, pd)} className={`last ${day && day.change >= 0 ? "up" : "down"}`} />
          <div className="stat"><span>{t.venueTag} {t.chg24}</span><b className={day && day.change >= 0 ? "up" : "down"}>{formatPct(day?.change)}</b></div>
          {advanced ? (
          <>
          <div className="stat"><span>{t.venueTag} {t.high24}</span><b className="num">{formatPx(day?.high, pd)}</b></div>
          <div className="stat"><span>{t.venueTag} {t.low24}</span><b className="num">{formatPx(day?.low, pd)}</b></div>
          <div className="stat vol-venue" title={t.venueVol}>
            <span>{t.venueVol}</span>
            <b className="num">{compactUsd(ticker?.venueVolumeUsd)}</b>
            <small>{t.venueTag}</small>
          </div>
          <div className="stat vol-global" title={`${ticker?.global?.note ?? t.noGlobalVol}${ticker?.global?.source ? ` · ${ticker.global.source}` : ""} · ${clock(ticker?.global?.updatedAt)}`}>
            <span>{t.globalVol} {ticker?.global?.delayed ? <em className="delay-badge">{t.dataDelayed}</em> : null}</span>
            <b className="num">{globalLabel(ticker?.global, t.otcVolume)}</b>
            <small>{ticker?.global?.source ?? t.globalTag} · {clock(ticker?.global?.updatedAt)}</small>
          </div>
          </>
          ) : null}
          {book?.halted ? <span className="badge bad">{t.halted}</span> : <span className="badge warn">{t.demoBook}</span>}
          <button type="button" className="langbtn mode-flip" onClick={() => setDesk(!advanced)} title={advanced ? copy.simpleHint : copy.advancedHint}>{advanced ? copy.simple : copy.advanced}</button>
          {internal ? null : <button type="button" className={`paper-toggle ${paper ? "on" : ""}`} aria-pressed={paper} onClick={() => void togglePaper()}>{t.paperMode}</button>}
          {paper ? <button type="button" className="paper-reset" onClick={() => void resetPaper()}>{t.paperReset}</button> : null}
          {paper ? <div className="paper-banner">{t.paperBanner}. {t.paperHint}</div> : null}
        </header>
        <div className="mob-strip">
          {(watch.length ? filtered.filter((item) => watch.includes(item.symbol)) : filtered).slice(0, 24).map((item) => (
            <button key={item.symbol} type="button" data-symbol={item.symbol} className={item.symbol === symbol ? "on" : ""} onClick={() => pick(item.symbol)}>{item.symbol}</button>
          ))}
        </div>
        <aside className="panel mkts" data-tour="markets">
          <button type="button" className="resize-handle" aria-label={t.resizePanel} onPointerDown={(e) => { e.preventDefault(); drag("m", e.clientX, cols.m); }} />
          <input className="search" value={query} placeholder={t.searchMarkets} onChange={(e) => setQuery(e.target.value)} />
          <div className="tabs">
            {CATS.map((item) => (
              <button key={item} type="button" data-cat={item} className={cat === item ? "on" : ""} onClick={() => setCat(item)}>{catLabel[item]}</button>
            ))}
          </div>
          {filtered.filter((item) => watch.includes(item.symbol)).slice(0, 8).map((item) => (
            <Row key={`w${item.symbol}`} item={item} active={item.symbol === symbol} lang={lang} ticker={tickerOf(item.symbol)} onPick={pick} onWatch={toggleWatch} watched />
          ))}
          <h2 style={{ marginTop: 8 }}>{t.markets} · {list.length}</h2>
          <div className="mkt-list">
            {filtered.map((item) => (
              <Row key={item.symbol} item={item} active={item.symbol === symbol} lang={lang} ticker={tickerOf(item.symbol)} onPick={pick} onWatch={toggleWatch} watched={watch.includes(item.symbol)} />
            ))}
          </div>
        </aside>
        <section className="panel chart-wrap" data-tour="chart">
          <div className="tf">
            {TIMEFRAMES.map((item) => (
              <button key={item.id} type="button" className={tf === item.id ? "on" : ""} onClick={() => setTf(item.id)}>{item.id}</button>
            ))}
            {advanced ? (
              <>
            <span className="tool-gap" />
            {(["ma", "ema", "boll", "vol", "macd", "rsi"] as const).map((key) => (
              <button key={key} type="button" className={studies[key] ? "on" : ""} onClick={() => toggleStudy(key)}>
                {key === "ma" ? t.indMA : key === "ema" ? t.indEMA : key === "boll" ? t.indBOLL : key === "vol" ? t.indVOL : key === "macd" ? t.indMACD : t.indRSI}
              </button>
            ))}
            <button type="button" className={drawMode === "trend" ? "on" : ""} onClick={() => setDrawMode(drawMode === "trend" ? "none" : "trend")} title={t.drawTrend}><Icon name="trend" /></button>
            <button type="button" className={drawMode === "hline" ? "on" : ""} onClick={() => setDrawMode(drawMode === "hline" ? "none" : "hline")} title={t.drawHline}><Icon name="hline" /></button>
            <button type="button" className={drawMode === "fib" ? "on" : ""} onClick={() => setDrawMode(drawMode === "fib" ? "none" : "fib")} title={t.drawFib}><Icon name="fib" /></button>
            <button type="button" onClick={() => setClearDraw((n) => n + 1)}>{t.drawClear}</button>
            <button type="button" className={volMode === "venue" ? "on" : ""} onClick={() => setVolMode("venue")}>{t.chartVolVenue}</button>
            <button type="button" className={volMode === "global" ? "on" : ""} onClick={() => setVolMode("global")}>{t.chartVolGlobal}</button>
              </>
            ) : null}
          </div>
          {bars.length ? (
            <CandleChart
              bars={bars}
              volumes={volumes}
              symbol={symbol}
              tf={tf}
              studies={chartStudies}
              drawMode={drawMode}
              clearDraw={clearDraw}
              fitKey={`${symbol}:${tf}`}
              onOlder={loadOlder}
            />
          ) : chartState === "error" ? (
            <div className="empty-chart" data-testid="quote-unavailable"><EmptyMark /><p>{t.quoteUnavailable}</p><button type="button" onClick={retryQuote}>{t.quoteRetry}</button></div>
          ) : chartState === "empty" ? (
            <div className="empty-chart"><EmptyMark /><p>{t.emptyChart}</p><button type="button" onClick={retryQuote}>{t.quoteRetry}</button></div>
          ) : <div className="skeleton chart-host" />}
          {advanced ? <p className="hint">{t.chartCredit} {t.sessionStats} {inst ? `· ${inst.regulatory_tag}` : ""}</p> : null}
          <ReferenceDepth symbol={symbol} />
        </section>
        <aside className="book-col" data-tour="book">
          <button type="button" className="resize-handle" aria-label={t.resizePanel} onPointerDown={(e) => { e.preventDefault(); drag("b", e.clientX, cols.b); }} />
          <BookPanel book={book} unavailable={feed === "down" || chartState === "error" || quoteLate} onRetry={retryQuote} onPrice={setPrice} onQty={setQty} />
          <Tape trades={trades} book={book} />
        </aside>
        <aside className="ticket-col" data-tour="ticket">
          <button type="button" className="resize-handle" aria-label={t.resizePanel} onPointerDown={(e) => { e.preventDefault(); drag("t", e.clientX, cols.t); }} />
          {advanced ? <PriceAlertForm symbol={symbol} price={shownLast === null ? "" : shownLast.toFixed(pd)} /> : null}
          {tradable || paper ? (
            <Ticket simple={!advanced} symbols={pickerSymbols(filtered.map((item) => item.symbol), symbol).map((sym) => ({ symbol: sym }))} onSymbol={pick} paper={paper} book={book} balances={balances} onDone={() => loadAccount(paper)} price={price} setPrice={setPrice} qty={qty} setQty={setQty} side={side} setSide={setSide} />
          ) : (
            <div className="panel"><h2>{t.ticket}</h2><p className="hint">{t.categoryPending}</p></div>
          )}
          {!advanced ? (
            <div className="simple-book">
              <button type="button" className="simple-book-toggle" aria-expanded={showBook} onClick={() => setShowBook((v) => !v)}>
                {showBook ? copy.hideBook : copy.showBook} <span aria-hidden>{showBook ? "▴" : "▾"}</span>
              </button>
              {showBook ? (
                <div className="simple-book-body">
                  <BookPanel book={book} unavailable={feed === "down" || chartState === "error" || quoteLate} onRetry={retryQuote} onPrice={setPrice} onQty={setQty} />
                  <Tape trades={trades} book={book} />
                </div>
              ) : null}
            </div>
          ) : null}
        </aside>
        <section className="panel dock">
          {!advanced ? (
            <button type="button" className="orders-toggle" onClick={() => setOrdersOpen((open) => !open)}>{t.yourOrders}</button>
          ) : null}
          {advanced || ordersOpen ? (
          <>
          <div className="tabs">
            <button type="button" className={tab === "open" ? "on" : ""} onClick={() => setTab("open")}>{t.openOrders}</button>
            <button type="button" className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>{t.orderHistory}</button>
            <button type="button" className={tab === "trades" ? "on" : ""} onClick={() => setTab("trades")}>{t.tradeHistory}</button>
            <button type="button" className={tab === "balances" ? "on" : ""} onClick={() => setTab("balances")}>{t.fundsTab}</button>
            {tab === "open" ? <Button size="sm" variant="outline" onClick={() => void cancelAll()}>{t.cancelAll}</Button> : null}
          </div>
          {tab === "balances" ? (
            <div className="bal-grid">
              {(balances?.assets ?? []).slice(0, 8).map((row) => (
                <div className="bal" key={row.asset}><span>{row.asset}</span><b className="num">{fromScale(row.available, row.qtyScale, row.qtyDecimals)}</b><div className="hint">{formatUsd(row.usd)}</div></div>
              ))}
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  {tab === "trades" ? (
                    <><th>{t.time}</th><th></th><th>{t.side}</th><th>{t.price}</th><th>{t.qty}</th><th>{t.est}</th><th>{t.fee}</th></>
                  ) : (
                    <><th>{t.time}</th><th></th><th>{t.side}</th><th>{t.type}</th><th>{t.price}</th><th>{t.qty}</th><th>{t.status}</th><th></th></>
                  )}
                </tr>
              </thead>
              <tbody>
                {tab === "trades" ? (mine.length === 0 ? (
                  <tr><td colSpan={7} className="hint">{copy.emptyTrades}</td></tr>
                ) : mine.map((trade) => (
                  <tr key={trade.engine_trade_id}>
                    <td>{timeLabel(trade.tape_at)}</td>
                    <td>{trade.symbol}</td>
                    <td className={trade.userSide === "buy" ? "bid" : "ask"}>{trade.userSide}</td>
                    <td className="num">{trade.price_cents}</td>
                    <td className="num">{formatQtyWithUnit(trade.symbol || symbol, trade.qty_mg, words)}</td>
                    <td className="num">{formatUsd(trade.notional_uusd)}</td>
                    <td className="num">{trade.fee_uusd ? formatUsd(trade.fee_uusd) : "—"}</td>
                  </tr>
                ))) : (tab === "open" ? open : history).length === 0 ? (
                  <tr><td colSpan={8} className="hint">{copy.emptyOrders}</td></tr>
                ) : (tab === "open" ? open : history).map((order) => (
                  <tr key={order.engine_order_id}>
                    <td>{timeLabel(order.created_at)}</td>
                    <td>{order.symbol}</td>
                    <td className={order.side === "buy" ? "bid" : "ask"}>{order.side}</td>
                    <td>{order.order_type}</td>
                    <td className="num">{order.price_cents ?? "—"}</td>
                    <td className="num">{formatQtyWithUnit(order.symbol || symbol, order.qty_mg, words)}</td>
                    <td>{order.status}{order.reject_reason ? ` · ${reasonText(lang, order.reject_reason)}` : ""}</td>
                    <td>
                      {tab === "open" ? (
                        <span style={{ display: "flex", gap: 6 }}>
                          {paper ? null : <Button size="sm" variant="outline" onClick={() => void amend(order)}>{t.amend}</Button>}
                          <Button size="sm" variant="ghost" onClick={() => void cancel(order.engine_order_id)}>{t.cancel}</Button>
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          </>
          ) : null}
        </section>
        <nav className="mob-tabs pro-mob-tabs" aria-label={t.trade}>
          <button type="button" className={pane !== "chart" ? "on" : ""} onClick={() => setPane("ticket")}>{t.tabOrder}</button>
          <button type="button" className={pane === "chart" ? "on" : ""} onClick={() => setPane(pane === "chart" ? "ticket" : "chart")}>{t.tabChart}</button>
        </nav>
      </div>
    </Shell>
  );
}

function Row({
  item, active, lang, ticker, onPick, onWatch, watched,
}: {
  item: Inst;
  active: boolean;
  lang: string;
  ticker?: Ticker;
  onPick: (symbol: string) => void;
  onWatch: (symbol: string) => void;
  watched: boolean;
}) {
  const { t } = useI18n();
  const px = ticker ? ticker.last / ticker.priceScale : null;
  return (
    <div
      className={`mkt-row ${active ? "on" : ""}`}
      data-symbol={item.symbol}
      role="button"
      tabIndex={0}
      onClick={() => onPick(item.symbol)}
      onKeyDown={(ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          onPick(item.symbol);
        }
      }}
    >
      <button type="button" aria-label={item.symbol} style={{ background: "none", border: 0, color: watched ? "#e0b15a" : "#8b97a6", cursor: "pointer" }} onClick={(ev) => { ev.stopPropagation(); onWatch(item.symbol); }}>{watched ? "★" : "☆"}</button>
      <span>
        <b>{item.symbol}</b>
        <div className="hint">{lang === "zh" ? item.name_zh : item.name_en}</div>
        <div className="hint vol-line" title={ticker?.global?.note ?? ""}>
          <span>{ticker ? compactUsd(ticker.venueVolumeUsd) : "—"}</span>
          <span className="global-bit">{globalLabel(ticker?.global, t.otcVolume)}</span>
        </div>
      </span>
      <span className={`num ${ticker && ticker.change >= 0 ? "up" : "down"}`}>{formatPx(px, ticker?.priceDecimals ?? item.price_decimals)}</span>
    </div>
  );
}
