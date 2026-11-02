"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, type Book } from "@/lib/api";
import { formatUsd } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { fromScale } from "@/lib/markets";
import { qtySpec, unitLabel } from "@/lib/qty";

type Balances = {
  USD: { available: string; reserved: string };
  XAU: { available: string; reserved: string };
  assets?: { asset: string; available: string; reserved: string; usd: string; qtyScale: number; qtyDecimals: number }[];
};

type FeeTier = { product: string; tier: number; min_volume_uusd: string; maker_bps: number; taker_bps: number };
type FeeMe = { tier: number; maker: number; taker: number } | null;
type FeeView = { tiers: FeeTier[]; spot: FeeMe; perp: FeeMe; margin: string };

const TIFS = ["limit", "ioc", "fok", "post_only"] as const;
type Tab = "limit" | "market" | "stop_limit" | "oco";

export function DeskTicket({
  book,
  balances,
  price,
  setPrice,
  busy,
  error,
  onPlace,
}: {
  book: Book | null;
  balances: Balances | null;
  price: string;
  setPrice: (v: string) => void;
  busy: boolean;
  error: string;
  onPlace: (input: { side: "buy" | "sell"; quantity: string; orderType: string; stop: string; stopLimit: string }) => void;
}) {
  const { t } = useI18n();
  const [fees, setFees] = useState<FeeView | null>(null);
  const [help, setHelp] = useState(false);
  useEffect(() => {
    api<FeeView>("/api/fees").then(setFees).catch(() => setFees(null));
  }, []);
  const spot = fees?.spot;
  const maker = spot?.maker ?? fees?.tiers.find((row) => row.product === "spot" && row.tier === 0)?.maker_bps;
  const taker = spot?.taker ?? fees?.tiers.find((row) => row.product === "spot" && row.tier === 0)?.taker_bps;
  return (
    <div className="panel ticket desk-ticket" data-testid="desk-ticket">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <h2>{t.ticket}</h2>
        <span className="fee-pop">
          <button type="button" onClick={() => setHelp((open) => !open)}>{t.feeRate}</button>
          {help ? (
            <div className="pop">
              <p className="hint" style={{ marginTop: 0 }}>{t.yourTier} VIP {spot ? spot.tier : "—"}</p>
              <p className="hint">{t.feeMaker} {maker == null ? "—" : `${(maker / 100).toFixed(2)}%`} · {t.feeTaker} {taker == null ? "—" : `${(taker / 100).toFixed(2)}%`}</p>
              <p className="hint">{t.feeHelp}</p>
              <p className="hint">{t.feeNewFills}</p>
            </div>
          ) : null}
        </span>
      </div>
      <div className="dual-ticket">
        <SideForm side="buy" book={book} balances={balances} price={price} setPrice={setPrice} maker={maker} taker={taker} busy={busy} onPlace={onPlace} />
        <SideForm side="sell" book={book} balances={balances} price={price} setPrice={setPrice} maker={maker} taker={taker} busy={busy} onPlace={onPlace} />
      </div>
      {error ? <p className="err">{error}</p> : null}
    </div>
  );
}

function SideForm({
  side, book, balances, price, setPrice, maker, taker, busy, onPlace,
}: {
  side: "buy" | "sell";
  book: Book | null;
  balances: Balances | null;
  price: string;
  setPrice: (v: string) => void;
  maker?: number;
  taker?: number;
  busy: boolean;
  onPlace: (input: { side: "buy" | "sell"; quantity: string; orderType: string; stop: string; stopLimit: string }) => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("limit");
  const [tif, setTif] = useState<(typeof TIFS)[number]>("limit");
  const [qty, setQty] = useState("");
  const [total, setTotal] = useState("");
  const [stop, setStop] = useState("");
  const [stopLimit, setStopLimit] = useState("");
  const spec = qtySpec(book?.symbol || book?.base || "XAU/USD");
  const unit = unitLabel(spec, { gram: t.unitGram, kilogram: t.unitKg, ounce: t.unitOz });
  const quote = book?.quote || "USD";
  const qtyDec = book?.qtyDecimals ?? 3;
  const priceScale = book?.priceScale ?? 100;
  const touch = side === "buy" ? book?.asks[0]?.price : book?.bids[0]?.price;
  const mkt = Number(touch ?? book?.lastPrice ?? book?.referencePrice ?? 0) / priceScale;
  const px = tab === "market" ? mkt : Number(price);
  const orderType = tab === "limit" ? tif : tab;

  function bucket(asset: string) {
    if (asset === "USD") return { available: balances?.USD.available ?? "0", scale: 1_000_000 };
    if (asset === "XAU") return { available: balances?.XAU.available ?? "0", scale: balances?.assets?.find((row) => row.asset === "XAU")?.qtyScale ?? 1000 };
    const row = balances?.assets?.find((item) => item.asset === asset);
    return { available: row?.available ?? "0", scale: row?.qtyScale ?? book?.qtyScale ?? 1000 };
  }

  function applyPct(pct: number) {
    if (!balances || !(px > 0)) return;
    let next = "";
    if (side === "sell") {
      const base = bucket(book?.base ?? "XAU");
      next = ((Number(base.available) / base.scale) * pct).toFixed(qtyDec);
    } else {
      const row = bucket(book?.quote ?? "USD");
      const units = (Number(row.available) / row.scale) * pct;
      next = (units / px).toFixed(qtyDec);
    }
    setQty(next);
    setTotal((Number(next) * px).toFixed(2));
  }

  const avail = (() => {
    if (!balances) return "—";
    if (side === "buy" && (book?.quote ?? "USD") === "USD") return formatUsd(balances.USD.available);
    const asset = side === "buy" ? (book?.quote ?? "USD") : (book?.base ?? "XAU");
    const row = bucket(asset);
    return `${fromScale(row.available, row.scale, qtyDec)} ${asset}`;
  })();

  const notional = Number(qty) > 0 && px > 0 ? Number(qty) * px : 0;
  const bps = tab === "limit" && (tif === "limit" || tif === "post_only") ? maker : taker;
  const feeText = bps == null || !notional ? "—" : `$${((notional * bps) / 10_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  const labels: Record<string, string> = {
    limit: t.limit, market: t.market, ioc: t.ioc, fok: t.fok, post_only: t.post, stop_limit: t.stopLimit, oco: t.oco,
  };

  return (
    <form
      className="side-form"
      onSubmit={(e) => {
        e.preventDefault();
        onPlace({ side, quantity: qty, orderType, stop, stopLimit });
      }}
    >
      <div className="tabs">
        {(["limit", "market", "stop_limit", "oco"] as const).map((item) => (
          <button key={item} type="button" className={tab === item ? "on" : ""} onClick={() => setTab(item)}>{labels[item]}</button>
        ))}
      </div>
      {tab === "limit" ? (
        <div className="seg" style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {TIFS.map((item) => (
            <button key={item} type="button" className={tif === item ? "on" : ""} onClick={() => setTif(item)}>{labels[item]}</button>
          ))}
        </div>
      ) : null}
      {tab !== "market" ? (
        <label className="field-suffix">
          <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" aria-label={t.price} />
          <em>{quote}</em>
        </label>
      ) : null}
      {tab === "stop_limit" || tab === "oco" ? (
        <label className="field-suffix">
          <input value={stop} onChange={(e) => setStop(e.target.value)} inputMode="decimal" placeholder={t.stopPrice} aria-label={t.stopPrice} />
          <em>{quote}</em>
        </label>
      ) : null}
      {tab === "oco" ? (
        <label className="field-suffix">
          <input value={stopLimit} onChange={(e) => setStopLimit(e.target.value)} inputMode="decimal" placeholder={t.stopLimit} aria-label={t.stopLimit} />
          <em>{quote}</em>
        </label>
      ) : null}
      <label className="field-suffix">
        <input
          value={qty}
          onChange={(e) => {
            setQty(e.target.value);
            const n = Number(e.target.value);
            if (px > 0 && n > 0) setTotal((n * px).toFixed(2));
            else setTotal("");
          }}
          inputMode="decimal"
          aria-label={t.qty}
        />
        <em>{unit}</em>
      </label>
      <label className="field-suffix">
        <input
          value={total}
          onChange={(e) => {
            setTotal(e.target.value);
            const n = Number(e.target.value);
            if (px > 0 && n > 0) setQty((n / px).toFixed(qtyDec));
          }}
          inputMode="decimal"
          aria-label={t.orderTotal}
        />
        <em>{quote}</em>
      </label>
      <input type="range" min={0} max={100} step={25} defaultValue={0} aria-label="25/50/75/100" onChange={(e) => applyPct(Number(e.target.value) / 100)} />
      <div className="pct">
        {[0.25, 0.5, 0.75, 1].map((pct) => (
          <button key={pct} type="button" onClick={() => applyPct(pct)}>{pct * 100}%</button>
        ))}
      </div>
      <p className="hint">{t.available} {avail}</p>
      <p className="hint">{t.estFee} {feeText} · {bps == null ? "—" : `${(bps / 100).toFixed(2)}%`} {tab === "limit" && (tif === "limit" || tif === "post_only") ? t.feeMaker : t.feeTaker}</p>
      <Button className="ticket-submit" variant={side === "buy" ? "desk" : "danger"} disabled={busy} style={{ width: "100%" }}>
        {side === "buy" ? t.buy : t.sell} {labels[orderType] ?? orderType}
      </Button>
    </form>
  );
}
