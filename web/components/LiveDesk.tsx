"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { EmptyMark } from "@/components/EmptyMark";
import { ComingSoon, DeskLoading } from "@/components/ComingSoon";
import { api } from "@/lib/api";
import { centsToUsd, formatUsd, timeLabel } from "@/lib/format";
import { reasonText, useI18n } from "@/lib/i18n";
import { liveQty, parseLivePrice, parseLiveQty, parseUsdMicro, type LiveQty } from "@/lib/liveQty";
import { fillTemplate, formatQtyWithUnit, qtySpec, unitLabel } from "@/lib/qty";
import { pctLeverage, quoteLeverage, type AmountMode } from "@/lib/simple-math";
import { SimpleOrder } from "@/components/SimpleOrder";
import { ReferenceDepth } from "@/components/ReferenceDepth";

type Product = "margin" | "perp";
type WalletName = "spot" | "margin" | "derivatives";
type Market = { symbol: string; mark: string; index: string; fundingBps: number; fundingAt: string };
type Pos = {
  id: string;
  symbol: string;
  side: string;
  qty: string;
  entry_px: string;
  leverage: number;
  margin_uusd: string;
  margin_mode: string;
  tp_px: string | null;
  sl_px: string | null;
  status: string;
  mark: string;
  upnlUusd: string;
  liq: string | null;
  notionalUusd?: string;
  realized_uusd?: string;
};
type Order = {
  id: string;
  symbol: string;
  side: string;
  order_type: string;
  qty: string;
  limit_px: string | null;
  reduce_only: boolean;
  status: string;
  avg_px: string | null;
  created_at: string;
};
type Fill = {
  id: string;
  symbol: string;
  side: string;
  qty: string;
  price_px: string;
  realized_uusd: string;
  fee_uusd?: string | null;
  kind: string;
  created_at: string;
};
type Board = {
  live: boolean;
  reduceOnly: boolean;
  access: string;
  mode: "cross" | "isolated";
  leverage: number;
  maxLeverage: number;
  maxNotionalUusd?: string;
  freeUusd?: string;
  wallets: { spotUusd: string; marginUusd: string; derivativesUusd: string };
  markets: Market[];
  positions: Pos[];
  orders: Order[];
  history: Order[];
  fills: Fill[];
};

const MARGIN_SYMBOLS = ["XAU/USD", "XAG/USD", "BTC/USD", "ETH/USD"];
const PERP_SYMBOLS = ["XAU-PERP", "BTC-PERP", "ETH-PERP"];

function countdown(iso: string, _tick: number, template: string): string {
  void _tick;
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "";
  const left = Math.max(0, ms);
  const h = Math.floor(left / 3_600_000);
  const m = Math.floor((left % 3_600_000) / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  return fillTemplate(template, { h: String(h), m: m.toString().padStart(2, "0"), s: s.toString().padStart(2, "0") });
}

function priceText(cents: string | null | undefined): string {
  if (cents == null || cents === "" || cents === "0") return "—";
  return centsToUsd(cents);
}

function EmptyBlock({ children }: { children: ReactNode }) {
  return (
    <div className="empty-chart">
      <EmptyMark />
      <p>{children}</p>
    </div>
  );
}

export function LiveDesk({ product }: { product: Product }) {
  const { t, lang } = useI18n();
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const symbols = product === "perp" ? PERP_SYMBOLS : MARGIN_SYMBOLS;
  const [symbol, setSymbol] = useState(symbols[0]);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [qty, setQty] = useState(qtySpec(symbols[0]).defaultQty);
  const [price, setPrice] = useState("");
  const [lev, setLev] = useState(2);
  const [mode, setMode] = useState<"cross" | "isolated">("isolated");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [tp, setTp] = useState("");
  const [sl, setSl] = useState("");
  const [ack, setAck] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [amount, setAmount] = useState("20.00");
  const [from, setFrom] = useState<WalletName>("spot");
  const [to, setTo] = useState<WalletName>(product === "margin" ? "margin" : "derivatives");
  const [clock, setClock] = useState(0);
  const [liveAdvanced, setLiveAdvanced] = useState(true);
  const [intent, setIntent] = useState<"open" | "close">("open");
  const [deskTab, setDeskTab] = useState<"positions" | "orders" | "history" | "fills" | "tx">("positions");
  const [tx, setTx] = useState<{ id: number; kind: string; asset: string; amount: string; detail: string | null; created_at: string }[]>([]);
  const [feeView, setFeeView] = useState<{ tiers: { product: string; tier: number; maker_bps: number; taker_bps: number }[]; spot: { tier: number; maker: number; taker: number } | null; perp: { tier: number; maker: number; taker: number } | null } | null>(null);
  const [amountMode, setAmountMode] = useState<AmountMode>("usd");
  const [spend, setSpend] = useState("");
  const [confirmOrder, setConfirmOrder] = useState(false);
  const words = { gram: t.unitGram, kilogram: t.unitKg, ounce: t.unitOz };

  function load() {
    api<Board>(product === "margin" ? "/api/margin" : "/api/perps")
      .then((res) => {
        setBoard(res);
        setMode(res.mode);
        setLev(Math.min(Math.max(2, res.leverage), res.maxLeverage));
        setError("");
      })
      .catch((err) => setError(reasonText(lang, (err as Error).message)))
      .finally(() => setLoading(false));
  }
  useEffect(() => {
    setLoading(true);
    setBoard(null);
    load();
  }, [product]);
  useEffect(() => {
    const id = setInterval(() => setClock((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    setLiveAdvanced(localStorage.getItem("meridex.liveAdvanced") !== "0");
    api<typeof feeView>("/api/fees").then((res) => { if (res) setFeeView(res); }).catch(() => undefined);
  }, []);
  function toggleLiveAdvanced(next: boolean) {
    setLiveAdvanced(next);
    localStorage.setItem("meridex.liveAdvanced", next ? "1" : "0");
    if (!next) {
      setOrderType("market");
      setReduceOnly(false);
      setTp("");
      setSl("");
    }
  }

  const spec = qtySpec(symbol);
  const size = liveQty(symbol);
  const unit = unitLabel(spec, words);
  const market = board?.markets.find((item) => item.symbol === symbol);
  const wallet = product === "margin" ? board?.wallets.marginUusd : board?.wallets.derivativesUusd;
  const free = board?.freeUusd ?? wallet ?? "0";
  const title = product === "margin" ? t.marginTitle : t.perpTitle;
  const us = board?.access === "US_RETAIL_BLOCK";
  const canOpen = Boolean(board?.live) && !us;
  const productWallet: WalletName = product === "margin" ? "margin" : "derivatives";
  const maxLev = board?.maxLeverage ?? 3;

  const estimate = useMemo(() => {
    const parsed = parseLiveQty(qty, size);
    const markCents = Number(market?.mark ?? 0);
    const mark = markCents / 100;
    if (!parsed.ok || !mark || mark <= 0) return null;
    const q = Number(parsed.raw) / size.scale;
    const notional = q * mark;
    const margin = notional / Math.max(lev, 1);
    const floor = notional / (2 * Math.max(lev, 1));
    const freeUsd = Number(free) / 1_000_000;
    const cushion = mode === "cross" ? Math.max(0, freeUsd - floor) : Math.max(0, margin - floor);
    const move = notional > 0 ? cushion / notional : 0;
    const liq = side === "buy" ? mark * (1 - move) : mark * (1 + move);
    const pct = liq > 0 ? (Math.abs(mark - liq) / mark) * 100 : null;
    return { notional, margin, liq: liq > 0 ? liq : null, pct };
  }, [qty, size, market?.mark, lev, side, mode, free]);

  const riskNear = estimate?.pct != null && estimate.pct < 20;
  const needAck = !reduceOnly && (lev > 3 || riskNear);

  function choose(next: string) {
    setSymbol(next);
    setQty(qtySpec(next).defaultQty);
    setPrice("");
    setTp("");
    setSl("");
    setError("");
  }

  function sizeError(text: string, rule: LiveQty): string {
    const parsed = parseLiveQty(text, rule);
    const hint = fillTemplate(t.liveMinHint, { n: rule.minText, step: rule.stepText, unit });
    if (!parsed.ok && parsed.reason === "format") return t.liveBadQty;
    if (!parsed.ok && parsed.reason === "min") return `${reasonText(lang, "MIN_QTY")} ${hint}`;
    if (!parsed.ok && parsed.reason === "step") return `${reasonText(lang, "STEP")} ${hint}`;
    return "";
  }

  function priceError(text: string, required: boolean): string {
    if (!text.trim()) return required ? t.liveNeedPrice : "";
    const parsed = parseLivePrice(text, size);
    if (!parsed.ok && parsed.reason === "format") return t.liveBadPrice;
    if (!parsed.ok) return `${reasonText(lang, "TICK")} ${fillTemplate(t.liveTickHint, { tick: size.tickText })}`;
    return "";
  }

  const sideRef = useRef(side);
  sideRef.current = side;
  function clientError(useSide: "buy" | "sell" = side): string {
    if (!market || market.mark === "0") return reasonText(lang, "EMPTY_BOOK");
    if (lev < 1 || lev > maxLev) return `${reasonText(lang, "CAP_LEVERAGE")} ${fillTemplate(t.liveLevRange, { max: String(maxLev) })}`;
    const qtyProblem = sizeError(qty, size);
    if (qtyProblem) return qtyProblem;
    const limitProblem = priceError(price, orderType === "limit");
    if (limitProblem) return limitProblem;
    const tpProblem = priceError(tp, false);
    if (tpProblem) return tpProblem;
    const slProblem = priceError(sl, false);
    if (slProblem) return slProblem;
    if (!reduceOnly && tp.trim()) {
      const parsed = parseLivePrice(tp, size);
      const mark = BigInt(market.mark);
      if (parsed.ok && (useSide === "buy" ? parsed.cents <= mark : parsed.cents >= mark)) return reasonText(lang, "STOP_PRICE");
    }
    if (!reduceOnly && sl.trim()) {
      const parsed = parseLivePrice(sl, size);
      const mark = BigInt(market.mark);
      if (parsed.ok && (useSide === "buy" ? parsed.cents >= mark : parsed.cents <= mark)) return reasonText(lang, "STOP_PRICE");
    }
    const openPos = board?.positions.find((pos) => pos.symbol === symbol);
    const closing = intent === "close" || reduceOnly;
    if (closing && (!openPos || openPos.side === useSide)) return reasonText(lang, "REDUCE_ONLY");
    const schedule = product === "perp" ? feeView?.perp : feeView?.spot;
    const fallback = feeView?.tiers.find((row) => row.product === (product === "perp" ? "perp" : "spot") && row.tier === (schedule?.tier ?? 0));
    const bps = orderType === "limit" ? (schedule?.maker ?? fallback?.maker_bps ?? 0) : (schedule?.taker ?? fallback?.taker_bps ?? 0);
    const feeMicro = estimate ? estimate.notional * bps * 100 : 0;
    if (intent === "open" && !reduceOnly && estimate && estimate.margin * 1_000_000 + feeMicro > Number(free)) return t.liveNeedFunds;
    if (needAck && !ack) return t.liveRiskNeed;
    return "";
  }

  async function run(path: string, body: unknown): Promise<boolean> {
    setError("");
    setBusy(true);
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) });
      load();
      return true;
    } catch (err) {
      setError(reasonText(lang, (err as Error).message));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const useSide = sideRef.current;
    const problem = clientError(useSide);
    if (problem) {
      setError(problem);
      return;
    }
    const ok = await run(product === "margin" ? "/api/margin/orders" : "/api/perps/orders", {
      symbol,
      side: useSide,
      quantity: qty.trim(),
      leverage: lev,
      orderType,
      price: orderType === "limit" ? price.trim() : null,
      reduceOnly: intent === "close" || reduceOnly,
      tp: tp.trim() || null,
      sl: sl.trim() || null,
      marginMode: mode,
    });
    if (ok) {
      setTp("");
      setSl("");
    }
  }

  async function saveSettings() {
    if (lev < 1 || lev > maxLev) {
      setError(`${reasonText(lang, "CAP_LEVERAGE")} ${fillTemplate(t.liveLevRange, { max: String(maxLev) })}`);
      return;
    }
    await run(product === "margin" ? "/api/margin" : "/api/perps/settings", { mode, leverage: lev });
  }

  function walletOf(name: WalletName): string {
    if (!board) return "0";
    if (name === "spot") return board.wallets.spotUusd;
    if (name === "margin") return board.wallets.marginUusd;
    return board.wallets.derivativesUusd;
  }

  async function transfer(e: FormEvent) {
    e.preventDefault();
    if (from === to) {
      setError(t.liveSameWallet);
      return;
    }
    if (!board?.live && to === productWallet) {
      setError(t.liveTransferOut);
      return;
    }
    const parsed = parseUsdMicro(amount);
    if (!parsed.ok) {
      setError(t.liveBadAmount);
      return;
    }
    const source = from === productWallet ? free : walletOf(from);
    if (parsed.micro > BigInt(source)) {
      setError(t.liveNeedWallet);
      return;
    }
    await run("/api/wallets/transfer", { from, to, amount: amount.trim() });
  }

  const statusText = (status: string) => {
    if (status === "open") return t.liveStatusOpen;
    if (status === "filled") return t.liveStatusFilled;
    if (status === "canceled" || status === "cancelled") return t.liveStatusCanceled;
    if (status === "liquidated") return t.liveKindLiq;
    if (status === "closed") return t.liveKindClose;
    return status;
  };
  const sideText = (value: string) => (value === "buy" ? t.liveLong : value === "sell" ? t.liveShort : value);
  const modeText = (value: string) => (value === "cross" ? t.marginCross : value === "isolated" ? t.marginIsolated : value);

  if (loading && !board) return <DeskLoading label={t.liveLoadingBoard} />;
  if (board && !board.live && !board.reduceOnly && !us) {
    return <ComingSoon title={title} extra={product === "perp" ? <ReferenceDepth symbol={symbol} /> : null} />;
  }

  const kindText: Record<string, string> = {
    open: t.liveKindOpen,
    close: t.liveKindClose,
    liquidation: t.liveKindLiq,
    funding: t.liveKindFunding,
    interest: t.liveKindInterest,
  };
  const hint = fillTemplate(t.liveMinHint, { n: size.minText, step: size.stepText, unit });
  const openOnSymbol = board?.positions.find((pos) => pos.symbol === symbol);
  const parsedQty = parseLiveQty(qty, size);
  const reduceTooBig = Boolean(reduceOnly && openOnSymbol && parsedQty.ok && parsedQty.raw > BigInt(openOnSymbol.qty));

  return (
    <Shell>
      <div className="page live-desk" aria-busy={busy}>
        <section className="panel">
          <h1>{title}</h1>
          {board?.live ? <p className="live-notice">{t.liveNotice}</p> : null}
          <p className="hint">{product === "margin" ? t.liveMarginBody : t.livePerpBody}</p>
          <p className="hint">{product === "margin" ? t.liveInterestNote : t.liveFundingNote}</p>
          {board?.reduceOnly ? <p className="live-warn">{t.liveReduce}</p> : null}
          {us ? <p className="err">{t.marginHardUs}</p> : null}
          {busy ? <p className="hint">{t.liveBusy}</p> : null}
          {error ? <p className="err" role="alert">{error}</p> : null}
        </section>
        {product === "perp" ? <ReferenceDepth symbol={symbol} /> : null}

        {us ? null : (
          <section className="panel">
            <h2>{t.liveTransfer}</h2>
            <p className="hint">{t.liveWalletHint}</p>
            <div className="cards">
              <article className="card"><h3>{t.liveSpot}</h3><div className="num">{board ? formatUsd(board.wallets.spotUusd) : "—"}</div></article>
              <article className="card"><h3>{t.liveMarginWallet}</h3><div className="num">{board ? formatUsd(board.wallets.marginUusd) : "—"}</div></article>
              <article className="card"><h3>{t.liveDerivWallet}</h3><div className="num">{board ? formatUsd(board.wallets.derivativesUusd) : "—"}</div></article>
            </div>
            <p className="hint">{t.liveFreeMargin} {formatUsd(free)}</p>
            <form className="split" onSubmit={transfer}>
              <label>{t.liveFrom}
                <select className="desk-input" value={from} onChange={(e) => setFrom(e.target.value as WalletName)}>
                  <option value="spot">{t.liveSpot}</option>
                  <option value="margin">{t.liveMarginWallet}</option>
                  <option value="derivatives">{t.liveDerivWallet}</option>
                </select>
              </label>
              <label>{t.liveTo}
                <select className="desk-input" value={to} onChange={(e) => setTo(e.target.value as WalletName)}>
                  <option value="spot">{t.liveSpot}</option>
                  <option value="margin">{t.liveMarginWallet}</option>
                  <option value="derivatives">{t.liveDerivWallet}</option>
                </select>
              </label>
              <label>{t.amount}
                <input className="desk-input" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" aria-invalid={error === t.liveBadAmount || error === t.liveNeedWallet} />
              </label>
              <Button type="submit" disabled={busy}>{t.liveTransfer}</Button>
            </form>
          </section>
        )}

        <div className="cards">
          {(board?.markets ?? []).map((item) => (
            <article key={item.symbol} className={`card ${symbol === item.symbol ? "on" : ""}`} onClick={() => choose(item.symbol)}>
              <h3>{item.symbol}</h3>
              <div className="num">{priceText(item.mark)}</div>
              {item.mark === "0" ? <p className="hint">{reasonText(lang, "EMPTY_BOOK")}</p> : (
                <>
                  <p className="hint">{t.perpIndex} {priceText(item.index)}</p>
                  <p className="hint">{product === "perp" ? t.perpFunding : t.liveInterest} {(item.fundingBps / 100).toFixed(2)}% · {countdown(item.fundingAt, clock, t.liveClock)}</p>
                </>
              )}
            </article>
          ))}
        </div>

        {canOpen && !liveAdvanced ? (
          <section className="panel">
            <SimpleOrder
              symbols={(board?.markets ?? symbols.map((item) => ({ symbol: item }))).map((item) => ({ symbol: item.symbol }))}
              symbol={symbol}
              onSymbol={choose}
              side={side}
              onSide={setSide}
              buyLabel={t.liveLong}
              sellLabel={t.liveShort}
              amount={spend}
              onAmount={setSpend}
              amountMode={amountMode}
              onAmountMode={setAmountMode}
              unit={unit}
              inputId="live-qty"
              onPct={(pct) => {
                const mark = Number(market?.mark ?? 0) / 100;
                setSpend(pctLeverage({ mode: amountMode, pct, price: mark, leverage: Math.min(Math.max(lev, 1), Math.min(3, maxLev)), freeUsd: Number(free) / 1_000_000, qtyDecimals: size.decimals }));
              }}
              pay={(() => {
                const mark = Number(market?.mark ?? 0) / 100;
                return quoteLeverage({ side, mode: amountMode, amount: spend, price: mark, leverage: Math.min(Math.max(lev, 1), Math.min(3, maxLev)), freeUsd: Number(free) / 1_000_000, qtyDecimals: size.decimals, unit }).pay;
              })()}
              receive={(() => {
                const mark = Number(market?.mark ?? 0) / 100;
                return quoteLeverage({ side, mode: amountMode, amount: spend, price: mark, leverage: Math.min(Math.max(lev, 1), Math.min(3, maxLev)), freeUsd: Number(free) / 1_000_000, qtyDecimals: size.decimals, unit }).receive;
              })()}
              fee={(() => {
                const mark = Number(market?.mark ?? 0) / 100;
                const schedule = product === "perp" ? feeView?.perp : feeView?.spot;
                const bps = schedule?.taker ?? (product === "perp" ? 5 : 10);
                return quoteLeverage({ side, mode: amountMode, amount: spend, price: mark, leverage: Math.min(Math.max(lev, 1), Math.min(3, maxLev)), freeUsd: Number(free) / 1_000_000, qtyDecimals: size.decimals, unit, feeBps: bps }).fee;
              })()}
              funds={(() => {
                const mark = Number(market?.mark ?? 0) / 100;
                return Boolean(spend) && quoteLeverage({ side, mode: amountMode, amount: spend, price: mark, leverage: Math.min(Math.max(lev, 1), Math.min(3, maxLev)), freeUsd: Number(free) / 1_000_000, qtyDecimals: size.decimals, unit }).reason === "funds";
              })()}
              error={error}
              busy={busy}
              goLabel={t.perpOpen}
              leverage={{
                value: Math.min(Math.max(lev, 1), Math.min(3, maxLev)),
                min: 1,
                max: Math.min(3, maxLev),
                onChange: (n) => { setLev(n); setAck(false); },
              }}
              liq={(() => {
                const mark = Number(market?.mark ?? 0) / 100;
                const row = quoteLeverage({ side, mode: amountMode, amount: spend, price: mark, leverage: Math.min(Math.max(lev, 1), Math.min(3, maxLev)), freeUsd: Number(free) / 1_000_000, qtyDecimals: size.decimals, unit });
                return row.liq == null ? "" : fillTemplate(t.liqPlain, { px: row.liq.toLocaleString("en-US", { maximumFractionDigits: 2 }) });
              })()}
              risk={t.levRisk}
              advancedOpen={false}
              onAdvanced={(open) => toggleLiveAdvanced(open)}
              onGo={() => {
                const mark = Number(market?.mark ?? 0) / 100;
                const row = quoteLeverage({ side, mode: amountMode, amount: spend, price: mark, leverage: Math.min(Math.max(lev, 1), Math.min(3, maxLev)), freeUsd: Number(free) / 1_000_000, qtyDecimals: size.decimals, unit });
                if (!row.ok || !row.quantity) {
                  setError(row.reason === "funds" ? t.needDeposit : t.liveBadQty);
                  return;
                }
                setQty(row.quantity);
                setError("");
                setConfirmOrder(true);
              }}
              confirmOpen={confirmOrder}
              confirmBody={`${side === "buy" ? t.liveLong : t.liveShort} ${symbol}`}
              onConfirmNo={() => setConfirmOrder(false)}
              onConfirmYes={() => {
                const mark = Number(market?.mark ?? 0) / 100;
                const row = quoteLeverage({ side, mode: amountMode, amount: spend, price: mark, leverage: Math.min(Math.max(lev, 1), Math.min(3, maxLev)), freeUsd: Number(free) / 1_000_000, qtyDecimals: size.decimals, unit });
                setConfirmOrder(false);
                if (!row.quantity) return;
                void run(product === "margin" ? "/api/margin/orders" : "/api/perps/orders", {
                  symbol,
                  side,
                  quantity: row.quantity,
                  leverage: Math.min(Math.max(lev, 1), Math.min(3, maxLev)),
                  orderType: "market",
                  price: null,
                  reduceOnly: false,
                  tp: null,
                  sl: null,
                  marginMode: "isolated",
                });
              }}
            />
          </section>
        ) : null}
        {canOpen && liveAdvanced ? (
          <form className="panel" onSubmit={submit}>
            <button type="button" className="advanced-toggle" data-testid="advanced-toggle" onClick={() => toggleLiveAdvanced(false)}>{t.simpleAdvanced}</button>
            <div className="tf">
              <button type="button" className={intent === "open" ? "on" : ""} onClick={() => setIntent("open")}>{t.intentOpen}</button>
              <button type="button" className={intent === "close" ? "on" : ""} onClick={() => { setIntent("close"); setReduceOnly(true); }}>{t.intentClose}</button>
              <button type="button" className={mode === "isolated" ? "on" : ""} onClick={() => setMode("isolated")}>{t.marginIsolated}</button>
              <button type="button" className={mode === "cross" ? "on" : ""} onClick={() => setMode("cross")}>{t.marginCross}</button>
            </div>
            <div className="tf">
              <button type="button" className={orderType === "limit" ? "on" : ""} onClick={() => setOrderType("limit")}>{t.liveLimit}</button>
              <button type="button" className={orderType === "market" ? "on" : ""} onClick={() => setOrderType("market")}>{t.liveMarket}</button>
              <button type="button" disabled title={t.liveBookNote}>{t.stopLimit}</button>
              <button type="button" className="on" title={t.tif}>{t.gtc}</button>
              <button type="button" disabled title={t.liveBookNote}>{t.ioc}</button>
              <button type="button" disabled title={t.liveBookNote}>{t.fok}</button>
              <button type="button" disabled title={t.liveBookNote}>{t.post}</button>
            </div>
            <p className="hint">{t.liveBookNote}</p>
            <p className="hint">{mode === "cross" ? t.liveCrossNote : t.liveIsolatedNote} {t.liveApplies}</p>
            <label htmlFor="live-qty">{fillTemplate(t.qtyWithUnit, { unit })}</label>
            <input id="live-qty" className="desk-input" value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" step={size.stepText} min={size.minText} aria-invalid={Boolean(sizeError(qty, size))} />
            <p className="hint">{hint} {fillTemplate(t.liveTickHint, { tick: size.tickText })} {fillTemplate(t.liveLevRange, { max: String(maxLev) })}</p>
            {orderType === "limit" ? (
              <>
                <label htmlFor="live-px">{t.liveOrderPrice}</label>
                <input id="live-px" className="desk-input" value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" step={Number(size.tick) / 100} />
              </>
            ) : null}
            <label htmlFor="live-lev">{lev}×</label>
            <input id="live-lev" type="range" min={1} max={maxLev} value={Math.min(Math.max(lev, 1), maxLev)} onChange={(e) => { setLev(Number(e.target.value)); setAck(false); }} />
            <div className="split">
              <div>
                <label htmlFor="live-tp">{t.perpTp}</label>
                <input id="live-tp" className="desk-input" value={tp} onChange={(e) => setTp(e.target.value)} inputMode="decimal" disabled={reduceOnly} />
              </div>
              <div>
                <label htmlFor="live-sl">{t.perpSl}</label>
                <input id="live-sl" className="desk-input" value={sl} onChange={(e) => setSl(e.target.value)} inputMode="decimal" disabled={reduceOnly} />
              </div>
            </div>
            <label className="checkline"><input type="checkbox" checked={reduceOnly} onChange={(e) => setReduceOnly(e.target.checked)} /> {t.liveReduceOnly}</label>
            {reduceTooBig ? <p className="hint">{t.liveReduceCap}</p> : null}
            {estimate ? (
              <p className="hint">
                {t.notional} {formatUsd(Math.round(estimate.notional * 1_000_000))}
                {" · "}{t.liveEstMargin} {formatUsd(Math.round(estimate.margin * 1_000_000))}
                {" · "}{t.liveFreeMargin} {formatUsd(free)}
                {board?.maxNotionalUusd ? ` · ${t.liveCap} ${formatUsd(board.maxNotionalUusd)}` : ""}
                {" · "}{t.liveLiqRisk} {estimate.liq == null ? "—" : centsToUsd(Math.round(estimate.liq * 100))}
                {estimate.pct != null ? ` · ${t.liveDist} ${estimate.pct.toFixed(1)}%` : ""}
                {" · "}{t.estFee} {(() => {
                  const schedule = product === "perp" ? feeView?.perp : feeView?.spot;
                  const fallback = feeView?.tiers.find((row) => row.product === (product === "perp" ? "perp" : "spot") && row.tier === (schedule?.tier ?? 0));
                  const bps = orderType === "limit" ? (schedule?.maker ?? fallback?.maker_bps) : (schedule?.taker ?? fallback?.taker_bps);
                  if (bps == null) return "—";
                  return `$${((estimate.notional * bps) / 10_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} · ${t.yourTier} VIP ${schedule?.tier ?? 0}`;
                })()}
              </p>
            ) : null}
            {riskNear && estimate?.pct != null ? <p className="live-warn">{fillTemplate(t.liveRiskNear, { pct: estimate.pct.toFixed(1) })}</p> : null}
            {needAck ? <label className="checkline"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> {t.liveRiskAck}</label> : null}
            <div className="btn-row">
              <Button type="submit" variant="desk" disabled={busy} onClick={() => { sideRef.current = "buy"; setSide("buy"); }}>{intent === "close" ? t.closeShort : (product === "perp" ? t.openLong : t.buy)}</Button>
              <Button type="submit" variant="danger" disabled={busy} onClick={() => { sideRef.current = "sell"; setSide("sell"); }}>{intent === "close" ? t.closeLong : (product === "perp" ? t.openShort : t.sell)}</Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => void saveSettings()}>{t.saveAccess}</Button>
            </div>
          </form>
        ) : null}

        <div className="tabs">
          <button type="button" className={deskTab === "positions" ? "on" : ""} onClick={() => setDeskTab("positions")}>{t.positions}</button>
          <button type="button" className={deskTab === "orders" ? "on" : ""} onClick={() => setDeskTab("orders")}>{t.liveOpenOrders}</button>
          <button type="button" className={deskTab === "history" ? "on" : ""} onClick={() => setDeskTab("history")}>{t.liveOrderHist}</button>
          <button type="button" className={deskTab === "fills" ? "on" : ""} onClick={() => setDeskTab("fills")}>{t.liveFills}</button>
          <button type="button" className={deskTab === "tx" ? "on" : ""} onClick={() => { setDeskTab("tx"); api<typeof tx>("/api/activity").then(setTx).catch(() => undefined); }}>{t.txnHistory}</button>
        </div>
        {deskTab === "positions" ? <section className="panel">
          <div className="section-head">
            <h2>{t.positions}</h2>
            {(board?.positions.length ?? 0) > 0 && !confirmAll ? (
              <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirmAll(true)}>{t.liveCloseAll}</Button>
            ) : null}
          </div>
          {confirmAll ? (
            <div className="live-confirm" role="alertdialog" aria-labelledby="close-all-title">
              <p id="close-all-title" className="live-warn">{t.liveCloseAllAsk}</p>
              <div className="btn-row">
                <Button type="button" variant="danger" disabled={busy} onClick={() => { setConfirmAll(false); void run(product === "margin" ? "/api/margin/close-all" : "/api/perps/close-all", {}); }}>{t.liveCloseAll}</Button>
                <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirmAll(false)}>{t.liveCancel}</Button>
              </div>
            </div>
          ) : null}
          {(board?.positions.length ?? 0) === 0 ? <EmptyBlock>{t.liveEmptyPos}</EmptyBlock> : (
            <ul className="pos-list">
              {board?.positions.map((pos) => (
                <PositionCard
                  key={pos.id}
                  pos={pos}
                  product={product}
                  words={words}
                  live={Boolean(board?.live)}
                  free={free}
                  busy={busy}
                  t={t}
                  lang={lang}
                  onError={setError}
                  onRun={run}
                />
              ))}
            </ul>
          )}
        </section> : null}

        {deskTab === "orders" ? <section className="panel">
          <h2>{t.liveOpenOrders}</h2>
          {(board?.orders.length ?? 0) === 0 ? <EmptyBlock>{t.liveNoOrders}</EmptyBlock> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>{t.time}</th><th>{t.symbol}</th><th>{t.side}</th><th></th><th>{t.qty}</th><th>{t.liveOrderPrice}</th><th></th></tr></thead>
                <tbody>
                  {board?.orders.map((row) => (
                    <tr key={row.id}>
                      <td>{timeLabel(row.created_at)}</td>
                      <td>{row.symbol}</td>
                      <td>{sideText(row.side)}</td>
                      <td>{row.order_type === "limit" ? t.liveLimit : t.liveMarket}{row.reduce_only ? ` · ${t.liveReduceOnly}` : ""}</td>
                      <td>{formatQtyWithUnit(row.symbol, row.qty, words)}</td>
                      <td className="num">{priceText(row.limit_px)}</td>
                      <td><Button size="sm" variant="outline" disabled={busy} onClick={() => void run(product === "margin" ? `/api/margin/orders/${row.id}/cancel` : `/api/perps/orders/${row.id}/cancel`, {})}>{t.cancel}</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section> : null}

        {deskTab === "history" ? <section className="panel">
          <h2>{t.liveOrderHist}</h2>
          {(board?.history.length ?? 0) === 0 ? <EmptyBlock>{t.liveHistEmpty}</EmptyBlock> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>{t.time}</th><th>{t.symbol}</th><th>{t.side}</th><th>{t.status}</th><th>{t.qty}</th><th>{t.last}</th></tr></thead>
                <tbody>
                  {board?.history.map((row) => (
                    <tr key={row.id}>
                      <td>{timeLabel(row.created_at)}</td>
                      <td>{row.symbol}</td>
                      <td>{sideText(row.side)}</td>
                      <td>{statusText(row.status)}</td>
                      <td>{formatQtyWithUnit(row.symbol, row.qty, words)}</td>
                      <td className="num">{priceText(row.avg_px)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section> : null}

        {deskTab === "fills" ? <section className="panel">
          <h2>{t.liveFills}</h2>
          {(board?.fills.length ?? 0) === 0 ? <EmptyBlock>{t.liveNoFills}</EmptyBlock> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>{t.time}</th><th>{t.symbol}</th><th></th><th>{t.qty}</th><th>{t.last}</th><th>{t.pnl}</th><th>{t.fee}</th></tr></thead>
                <tbody>
                  {board?.fills.map((row) => (
                    <tr key={row.id}>
                      <td>{timeLabel(row.created_at)}</td>
                      <td>{row.symbol}</td>
                      <td>{kindText[row.kind] ?? row.kind}</td>
                      <td>{row.qty === "0" ? "—" : formatQtyWithUnit(row.symbol, row.qty, words)}</td>
                      <td className="num">{priceText(row.price_px)}</td>
                      <td className={`num ${row.realized_uusd.startsWith("-") ? "down" : "up"}`}>{formatUsd(row.realized_uusd)}</td>
                      <td className="num">{row.fee_uusd ? formatUsd(row.fee_uusd) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section> : null}
        {deskTab === "tx" ? (
          <section className="panel">
            <h2>{t.txnHistory}</h2>
            {tx.length === 0 ? <EmptyBlock>{t.liveNoFills}</EmptyBlock> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>{t.time}</th><th></th><th></th><th>{t.amount}</th><th></th></tr></thead>
                  <tbody>
                    {tx.map((row) => (
                      <tr key={row.id}>
                        <td>{timeLabel(row.created_at)}</td>
                        <td>{row.kind}</td>
                        <td>{row.asset}</td>
                        <td className="num">{row.amount}</td>
                        <td>{row.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ) : null}
      </div>
    </Shell>
  );
}

function PositionCard({
  pos,
  product,
  words,
  live,
  free,
  busy,
  t,
  lang,
  onError,
  onRun,
}: {
  pos: Pos;
  product: Product;
  words: { gram: string; kilogram: string; ounce: string };
  live: boolean;
  free: string;
  busy: boolean;
  t: ReturnType<typeof useI18n>["t"];
  lang: ReturnType<typeof useI18n>["lang"];
  onError: (message: string) => void;
  onRun: (path: string, body: unknown) => Promise<boolean>;
}) {
  const [part, setPart] = useState("");
  const [closePx, setClosePx] = useState("");
  const [marginAmt, setMarginAmt] = useState("5.00");
  const base = product === "margin" ? `/api/margin/positions/${pos.id}` : `/api/perps/${pos.id}`;
  const size = liveQty(pos.symbol);
  const up = !pos.upnlUusd.startsWith("-") && pos.upnlUusd !== "0";
  const parsedPart = part.trim() ? parseLiveQty(part, size) : null;
  const remainderSmall = parsedPart?.ok === true && parsedPart.raw < BigInt(pos.qty) && BigInt(pos.qty) - parsedPart.raw < size.minRaw;

  function closePart() {
    if (!part.trim()) {
      onError(t.livePartialNeed);
      return;
    }
    if (!parsedPart?.ok) {
      onError(parsedPart?.reason === "min" ? reasonText(lang, "MIN_QTY") : parsedPart?.reason === "step" ? reasonText(lang, "STEP") : t.liveBadQty);
      return;
    }
    if (parsedPart.raw > BigInt(pos.qty)) {
      onError(t.livePartialOver);
      return;
    }
    void onRun(`${base}/close`, { quantity: part.trim() });
  }

  function margin(action: "add" | "remove") {
    if (action === "add" && !live) {
      onError(t.liveAddOff);
      return;
    }
    const parsed = parseUsdMicro(marginAmt);
    if (!parsed.ok) {
      onError(t.liveBadMargin);
      return;
    }
    if (action === "add" && parsed.micro > BigInt(free)) {
      onError(t.liveNeedFunds);
      return;
    }
    if (action === "remove" && pos.notionalUusd) {
      const floor = BigInt(pos.notionalUusd) / BigInt(Math.max(pos.leverage, 2) * 2);
      if (BigInt(pos.margin_uusd) - parsed.micro <= floor) {
        onError(reasonText(lang, "BELOW_MAINTENANCE"));
        return;
      }
    }
    void onRun(`${base}/margin`, { action, amount: marginAmt.trim() });
  }

  return (
    <li className="pos-card">
      <header className="pos-head">
        <b>{pos.symbol}</b>
        <span className={pos.side === "buy" ? "up" : "down"}>{pos.side === "buy" ? t.liveLong : t.liveShort}</span>
        <span>{pos.leverage}× · {pos.margin_mode === "cross" ? t.marginCross : t.marginIsolated}</span>
      </header>
      <dl className="pos-grid">
        <div><dt>{t.qty}</dt><dd>{formatQtyWithUnit(pos.symbol, pos.qty, words)}</dd></div>
        <div><dt>{t.liveEntry}</dt><dd className="num">{priceText(pos.entry_px)}</dd></div>
        <div><dt>{t.perpMark}</dt><dd className="num">{priceText(pos.mark)}</dd></div>
        <div><dt>{t.marginLiq}</dt><dd className="num">{priceText(pos.liq)}</dd></div>
        <div><dt>{t.liveUnreal}</dt><dd className={`num ${up ? "up" : "down"}`}>{formatUsd(pos.upnlUusd)}</dd></div>
        <div><dt>{t.roe}</dt><dd className={`num ${up ? "up" : "down"}`}>{Number(pos.margin_uusd) > 0 ? `${((Number(pos.upnlUusd) / Number(pos.margin_uusd)) * 100).toFixed(2)}%` : "—"}</dd></div>
        <div><dt>{t.liveEstMargin}</dt><dd className="num">{formatUsd(pos.margin_uusd)}</dd></div>
      </dl>
      <div className="pos-actions">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void onRun(`${base}/close`, {})}>{t.marketClose}</Button>
        <label className="grow">
          {t.limitClose}
          <input className="desk-input" value={closePx} onChange={(e) => setClosePx(e.target.value)} inputMode="decimal" />
        </label>
        <Button size="sm" variant="outline" disabled={busy || !closePx.trim()} onClick={() => {
          const scale = size.scale;
          const whole = (Number(pos.qty) / scale).toFixed(size.decimals);
          void onRun(product === "margin" ? "/api/margin/orders" : "/api/perps/orders", {
            symbol: pos.symbol,
            side: pos.side === "buy" ? "sell" : "buy",
            quantity: part.trim() || whole,
            leverage: Math.max(2, pos.leverage),
            orderType: "limit",
            price: closePx.trim(),
            reduceOnly: true,
            marginMode: pos.margin_mode,
          });
        }}>{t.limitClose}</Button>
        <label className="grow">
          {t.livePartialQty}
          <input className="desk-input" value={part} onChange={(e) => setPart(e.target.value)} inputMode="decimal" step={size.stepText} min={size.minText} />
        </label>
        <Button size="sm" variant="outline" disabled={busy} onClick={closePart}>{t.liveClosePartial}</Button>
        {remainderSmall ? <p className="hint">{t.livePartialRest}</p> : null}
        <label className="grow">
          {t.amount}
          <input className="desk-input" value={marginAmt} onChange={(e) => setMarginAmt(e.target.value)} inputMode="decimal" />
        </label>
        <Button size="sm" variant="outline" disabled={busy || !live} onClick={() => margin("add")}>{t.liveAdd}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => margin("remove")}>{t.liveRemove}</Button>
      </div>
    </li>
  );
}
