"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/Toast";
import { api, type Book } from "@/lib/api";
import { formatUsd } from "@/lib/format";
import { reasonText, useI18n } from "@/lib/i18n";
import { formatPx, fromScale } from "@/lib/markets";
import { fillTemplate, qtySpec, unitLabel } from "@/lib/qty";
import { pctSpot, quoteSpot, type AmountMode } from "@/lib/simple-math";
import { DeskTicket } from "@/components/DeskTicket";
import { SimpleOrder } from "@/components/SimpleOrder";

type Balances = {
  USD: { available: string; reserved: string };
  XAU: { available: string; reserved: string };
  assets?: { asset: string; available: string; reserved: string; usd: string; qtyScale: number; qtyDecimals: number }[];
};

export function BookPanel({
  book,
  unavailable,
  onRetry,
  onPrice,
  onQty,
}: {
  book: Book | null;
  unavailable?: boolean;
  onRetry?: () => void;
  onPrice?: (price: string) => void;
  onQty?: (qty: string) => void;
}) {
  const { t } = useI18n();
  const [view, setView] = useState<"both" | "bid" | "ask">("both");
  const [stepIdx, setStepIdx] = useState(0);
  const unit = book ? unitLabel(qtySpec(book.symbol || book.base || "XAU"), { gram: t.unitGram, kilogram: t.unitKg, ounce: t.unitOz }) : "";
  if (!book) {
    return (
      <div className="panel" style={{ flex: 1 }} data-testid={unavailable ? "quote-unavailable" : "book-loading"}>
        <h2>{t.ownBook}</h2>
        {unavailable ? (
          <>
            <p className="hint">{t.quoteUnavailable}</p>
            {onRetry ? <button type="button" onClick={onRetry}>{t.quoteRetry}</button> : null}
          </>
        ) : (
          <div className="skeleton" style={{ height: 180 }} />
        )}
      </div>
    );
  }
  const scale = book.priceScale ?? 100;
  const decimals = book.priceDecimals ?? 2;
  const baseStep = 10 ** -Math.min(decimals, 4);
  const steps = [baseStep, baseStep * 10, baseStep * 100, baseStep * 1000];
  const step = steps[Math.min(stepIdx, steps.length - 1)];
  const asks = aggregate(book.asks, step, scale, "ask").slice(0, 12).reverse();
  const bids = aggregate(book.bids, step, scale, "bid").slice(0, 12);
  const showAsks = view !== "bid";
  const showBids = view !== "ask";
  const askCum = cumulative(asks.map((lvl) => lvl.qty).reverse()).reverse();
  const bidCum = cumulative(bids.map((lvl) => lvl.qty));
  const askMax = askCum[0] || 1;
  const bidMax = bidCum[bidCum.length - 1] || 1;
  const bestAsk = book.asks[0]?.price;
  const bestBid = book.bids[0]?.price;
  const spread = bestAsk != null && bestBid != null ? (bestAsk - bestBid) / scale : null;
  const places = step >= 1 ? 0 : Math.min(decimals, Math.max(0, Math.round(-Math.log10(step))));
  return (
    <div className="panel book-panel" style={{ flex: 1, minHeight: 0 }}>
      <h2>{t.ownBook} · {book.symbol}</h2>
      <div className="book-tools">
        <button type="button" className={view === "both" ? "on" : ""} onClick={() => setView("both")}>{t.bookBoth}</button>
        <button type="button" className={view === "bid" ? "on" : ""} onClick={() => setView("bid")}>{t.bookBids}</button>
        <button type="button" className={view === "ask" ? "on" : ""} onClick={() => setView("ask")}>{t.bookAsks}</button>
        <label>
          {t.bookPrecision}{" "}
          <select value={stepIdx} onChange={(e) => setStepIdx(Number(e.target.value))} aria-label={t.bookPrecision}>
            {steps.map((value, i) => (
              <option key={value} value={i}>{value >= 1 ? value.toFixed(0) : value.toFixed(Math.min(4, decimals))}</option>
            ))}
          </select>
        </label>
      </div>
      {asks.length + bids.length === 0 ? <p className="hint">{t.emptyBook}</p> : null}
      <div className="book-asks">
      {showAsks ? asks.map((lvl, i) => (
        <Level key={`a${lvl.price}`} side="ask" price={lvl.price} qty={lvl.qty} width={(askCum[i] / askMax) * 100} onPrice={onPrice} onQty={onQty} book={book} unit={unit} places={places} scaled={false} />
      )) : null}
      </div>
      <div className="spread-row">
        <div className="mid-px num" key={book.lastPrice ?? book.referencePrice}>{fromScale(book.lastPrice ?? book.referencePrice, scale, decimals)}</div>
        <div className="hint">{t.spreadLabel} {spread === null ? "—" : `$${spread.toFixed(2)}`}</div>
      </div>
      <div className="book-bids">
      {showBids ? bids.map((lvl, i) => (
        <Level key={`b${lvl.price}`} side="bid" price={lvl.price} qty={lvl.qty} width={(bidCum[i] / bidMax) * 100} onPrice={onPrice} onQty={onQty} book={book} unit={unit} places={places} scaled={false} />
      )) : null}
      </div>
    </div>
  );
}

function aggregate(levels: { price: number; qty: number }[], step: number, priceScale: number, side: "bid" | "ask") {
  const map = new Map<number, number>();
  for (const lvl of levels) {
    const px = lvl.price / priceScale;
    const bucket = side === "ask" ? Math.ceil(px / step) * step : Math.floor(px / step) * step;
    const key = Math.round(bucket * 1e8);
    map.set(key, (map.get(key) ?? 0) + lvl.qty);
  }
  return [...map.entries()]
    .map(([key, qty]) => ({ price: key / 1e8, qty }))
    .sort((a, b) => (side === "ask" ? a.price - b.price : b.price - a.price));
}

function useFlash(value: string) {
  const prev = useRef(value);
  const [dir, setDir] = useState("");
  useEffect(() => {
    if (prev.current === value) return;
    const up = Number(value) >= Number(prev.current);
    prev.current = value;
    setDir(up ? "tick-up" : "tick-down");
    const id = window.setTimeout(() => setDir(""), 520);
    return () => window.clearTimeout(id);
  }, [value]);
  return dir;
}

function cumulative(qty: number[]): number[] {
  const out: number[] = [];
  let run = 0;
  for (const value of qty) {
    run += value;
    out.push(run);
  }
  return out;
}

function Level({
  side, price, qty, width, onPrice, onQty, book, unit, places, scaled = true,
}: {
  side: "bid" | "ask";
  price: number;
  qty: number;
  width: number;
  book: Book;
  unit: string;
  places?: number;
  scaled?: boolean;
  onPrice?: (price: string) => void;
  onQty?: (qty: string) => void;
}) {
  const px = scaled ? (price / (book.priceScale ?? 100)).toFixed(book.priceDecimals ?? 2) : price.toFixed(places ?? book.priceDecimals ?? 2);
  const q = (qty / (book.qtyScale ?? 1000)).toFixed(book.qtyDecimals ?? 3);
  const flash = useFlash(q);
  return (
    <div className={`book-row ${flash}`}>
      <div className={`bar ${side}`} style={{ width: `${Math.max(8, width)}%` }} />
      <button type="button" className={side} style={{ background: "none", border: 0, textAlign: "left", cursor: "pointer" }} onClick={() => onPrice?.(px)}>
        {px}
      </button>
      <button type="button" style={{ background: "none", border: 0, textAlign: "right", cursor: "pointer" }} onClick={() => onQty?.(q)}>
        {q}
      </button>
      <span style={{ color: "#8b97a6" }}>{unit}</span>
    </div>
  );
}

export function Tape({ trades, book }: { trades: { engine_trade_id: string; price_cents: string; qty_mg: string; taker_side: string; tape_at: string }[]; book?: Book | null }) {
  const { t } = useI18n();
  const ps = book?.priceScale ?? 100;
  const pd = book?.priceDecimals ?? 2;
  const qs = book?.qtyScale ?? 1000;
  const qd = book?.qtyDecimals ?? 3;
  const shown = trades.slice(0, 12);
  const maxQty = Math.max(1, ...shown.map((tr) => Number(tr.qty_mg) || 0));
  return (
    <div className="panel tape-panel" style={{ maxHeight: 180 }}>
      <h2>{t.ownTape}</h2>
      {shown.map((tr) => {
        const weight = (Number(tr.qty_mg) || 0) / maxQty;
        return (
          <div className={`tape-row ${weight > 0.62 ? "heavy" : ""}`} key={tr.engine_trade_id} style={{ ["--w" as string]: weight.toFixed(3) }}>
            <span className={tr.taker_side === "buy" ? "bid" : "ask"}>{fromScale(tr.price_cents, ps, pd)}</span>
            <span className="num">{fromScale(tr.qty_mg, qs, qd)} {book ? unitLabel(qtySpec(book.symbol || book.base || "XAU"), { gram: t.unitGram, kilogram: t.unitKg, ounce: t.unitOz }) : ""}</span>
            <span style={{ color: "#8b97a6" }}>{new Date(tr.tape_at).toLocaleTimeString("zh-CN", { hour12: false })}</span>
          </div>
        );
      })}
      {trades.length === 0 ? <p className="hint">{t.emptyTape}</p> : null}
    </div>
  );
}

const advanced = ["limit", "ioc", "fok", "post_only"] as const;

export function Ticket({
  book,
  balances,
  onDone,
  price,
  setPrice,
  qty,
  setQty,
  side,
  setSide,
  paper = false,
  simple = false,
  symbols,
  onSymbol,
}: {
  book: Book | null;
  balances: Balances | null;
  onDone: () => void;
  price: string;
  setPrice: (v: string) => void;
  qty: string;
  setQty: (v: string) => void;
  side: "buy" | "sell";
  setSide: (v: "buy" | "sell") => void;
  paper?: boolean;
  simple?: boolean;
  symbols?: { symbol: string }[];
  onSymbol?: (symbol: string) => void;
}) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const [tab, setTab] = useState<"limit" | "market" | "stop_limit" | "oco">(simple ? "market" : "limit");
  useEffect(() => {
    if (simple && (tab === "stop_limit" || tab === "oco")) setTab("market");
  }, [simple, tab]);
  const [tif, setTif] = useState<(typeof advanced)[number]>("limit");
  const [stop, setStop] = useState("131.00");
  const [stopLimit, setStopLimit] = useState("131.20");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState<{ side: "buy" | "sell"; quantity: string; orderType: string; stop: string; stopLimit: string } | null>(null);
  const [skip, setSkip] = useState(false);
  const [amountMode, setAmountMode] = useState<AmountMode>("usd");
  const [spend, setSpend] = useState("");
  const type = simple ? (tab === "market" ? "market" : "limit") : tab === "limit" ? tif : tab;
  const labels: Record<string, string> = {
    limit: t.limit, market: t.market, ioc: t.ioc, fok: t.fok, post_only: t.post, stop_limit: t.stopLimit, oco: t.oco,
  };
  const priceScale = book?.priceScale ?? 100;
  const qtyScale = book?.qtyScale ?? 1000;
  const qtyDec = book?.qtyDecimals ?? 3;
  const spec = qtySpec(book?.symbol || book?.base || "XAU/USD");
  const unit = unitLabel(spec, { gram: t.unitGram, kilogram: t.unitKg, ounce: t.unitOz });
  const px = type === "market" ? Number(book?.asks[0]?.price ?? book?.referencePrice ?? 0) / priceScale : Number(price);
  const est = useMemo(() => {
    const q = Number(qty);
    if (!q || !px) return "—";
    return `$${(q * px).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  }, [qty, px]);

  function bucket(asset: string): { available: string; scale: number } {
    if (asset === "USD") return { available: balances?.USD.available ?? "0", scale: 1_000_000 };
    if (asset === "XAU") return { available: balances?.XAU.available ?? "0", scale: balances?.assets?.find((row) => row.asset === "XAU")?.qtyScale ?? 1000 };
    const row = balances?.assets?.find((item) => item.asset === asset);
    return { available: row?.available ?? "0", scale: row?.qtyScale ?? qtyScale };
  }

  function applyPct(pct: number) {
    if (!balances) return;
    if (side === "sell") {
      const base = bucket(book?.base ?? "XAU");
      setQty(((Number(base.available) / base.scale) * pct).toFixed(qtyDec));
      return;
    }
    const quote = bucket(book?.quote ?? "USD");
    const units = (Number(quote.available) / (book?.quote === "USD" ? 1_000_000 : quote.scale)) * pct;
    if (!px) return;
    setQty((units / px).toFixed(qtyDec));
  }

  async function send(place?: { side?: "buy" | "sell"; quantity?: string; orderType?: string; stop?: string; stopLimit?: string } | string, orderTypeArg?: string) {
    const order = typeof place === "string" ? { quantity: place, orderType: orderTypeArg } : (place ?? {});
    const quantity = order.quantity ?? qty;
    const orderType = order.orderType ?? type;
    const orderSide = order.side ?? side;
    const useStop = order.stop ?? stop;
    const useStopLimit = order.stopLimit ?? stopLimit;
    setBusy(true);
    setError("");
    setConfirm(false);
    if (skip) localStorage.setItem("meridex.skipConfirm", "1");
    try {
      const res = await api<{ status: string; rejectReason: string | null; trades: { tradeId: string }[] }>(paper ? "/api/paper/orders" : "/api/orders", {
        method: "POST",
        body: JSON.stringify({
          side: orderSide,
          type: orderType,
          price: orderType === "market" ? null : price,
          stopPrice: orderType === "stop_limit" || orderType === "oco" ? useStop : null,
          stopLimitPrice: orderType === "oco" ? useStopLimit : null,
          quantity,
          symbol: book?.symbol ?? "XAU/USD",
        }),
      });
      const tone = res.rejectReason ? "bad" : "ok";
      const why = res.rejectReason ? reasonText(lang, res.rejectReason) : res.status;
      toast(`${labels[orderType] ?? orderType} ${orderSide === "buy" ? t.buy : t.sell} · ${why}`, tone);
      onDone();
    } catch (err) {
      const code = (err as Error).message;
      setError(code);
      toast(reasonText(lang, code), "bad");
    } finally {
      setBusy(false);
    }
  }

  function submit() {
    if (localStorage.getItem("meridex.skipConfirm") === "1") void send();
    else setConfirm(true);
  }

  const avail = (() => {
    if (!balances) return "—";
    if (side === "buy" && (book?.quote ?? "USD") === "USD") return formatUsd(balances.USD.available);
    const asset = side === "buy" ? (book?.quote ?? "USD") : (book?.base ?? "XAU");
    const row = bucket(asset);
    return `${fromScale(row.available, row.scale, book?.qtyDecimals ?? 3)} ${asset}`;
  })();

  const touch = side === "buy" ? book?.asks[0]?.price : book?.bids[0]?.price;
  const mktPx = Number(touch ?? book?.lastPrice ?? book?.referencePrice ?? 0) / priceScale;
  const usdAvail = Number(balances?.USD.available ?? 0) / 1_000_000;
  const baseAsset = book?.base || (book?.symbol || "XAU/USD").split(/[/-]/)[0] || "XAU";
  const baseRow = bucket(baseAsset);
  const baseAvail = Number(baseRow.available) / baseRow.scale;
  const quoted = quoteSpot({
    side,
    mode: amountMode,
    amount: spend,
    price: mktPx,
    usdAvailable: usdAvail,
    baseAvailable: baseAvail,
    qtyDecimals: qtyDec,
    unit,
  });
  const funds = error === "INSUFFICIENT_FUNDS" || error === "INSUFFICIENT_GOLD" || error === "INSUFFICIENT_BALANCE" || quoted.reason === "funds";

  if (simple) {
    return (
      <div className="panel ticket">
        <SimpleOrder
          symbols={symbols}
          symbol={book?.symbol || "XAU/USD"}
          onSymbol={onSymbol}
          side={side}
          onSide={setSide}
          buyLabel={t.buy}
          sellLabel={t.sell}
          amount={spend}
          onAmount={setSpend}
          amountMode={amountMode}
          onAmountMode={setAmountMode}
          unit={unit}
          onPct={(pct) => setSpend(pctSpot({ side, mode: amountMode, pct, price: mktPx, usdAvailable: usdAvail, baseAvailable: baseAvail, qtyDecimals: qtyDec }))}
          pay={quoted.pay}
          receive={quoted.receive}
          fee={quoted.fee}
          funds={funds && Boolean(spend)}
          error={error && !funds ? reasonText(lang, error) : ""}
          busy={busy}
          goLabel={side === "buy" ? t.buy : t.sell}
          onGo={() => {
            if (!quoted.ok) {
              setError(quoted.reason === "funds" ? "INSUFFICIENT_FUNDS" : "VALIDATION");
              return;
            }
            setError("");
            if (localStorage.getItem("meridex.skipConfirm") === "1") void send(quoted.quantity, "market");
            else setConfirm(true);
          }}
          confirmOpen={confirm}
          confirmBody={`${side === "buy" ? t.buy : t.sell} ${book?.symbol || ""}`}
          onConfirmYes={() => void send(quoted.quantity, "market")}
          onConfirmNo={() => setConfirm(false)}
        />
      </div>
    );
  }

  return (
    <>
      <DeskTicket
        book={book}
        balances={balances}
        price={price}
        setPrice={setPrice}
        busy={busy}
        error={error ? reasonText(lang, error) : ""}
        onPlace={(order) => {
          setPending(order);
          setSide(order.side);
          if (localStorage.getItem("meridex.skipConfirm") === "1") void send(order);
          else setConfirm(true);
        }}
      />
      {confirm ? (
        <div className="modal-back" onClick={() => setConfirm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{t.confirmTitle}</h2>
            <p>{labels[pending?.orderType ?? type] ?? pending?.orderType} · {pending?.side === "sell" ? t.sell : t.buy}</p>
            <p className="num">{pending?.orderType === "market" ? t.market : formatPx(Number(price), book?.priceDecimals)} · {pending?.quantity} {unit}</p>
            <p className="hint">{fillTemplate(t.qtyWithUnit, { unit })}</p>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} /> {t.confirmSkip}
            </label>
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <Button variant="outline" onClick={() => setConfirm(false)}>{t.cancel}</Button>
              <Button onClick={() => void send(pending ?? undefined)}>{t.confirmGo}</Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
