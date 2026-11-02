export type AmountMode = "usd" | "qty";

export type SpotQuote = {
  ok: boolean;
  reason: "amount" | "price" | "funds" | null;
  quantity: string;
  pay: string;
  receive: string;
  fee: string;
};

function trim(n: number, decimals: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  const places = Math.min(8, Math.max(0, decimals));
  const text = n.toFixed(places);
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}

function usd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function quoteSpot(input: {
  side: "buy" | "sell";
  mode: AmountMode;
  amount: string;
  price: number;
  usdAvailable: number;
  baseAvailable: number;
  qtyDecimals: number;
  unit: string;
  feeBps?: number;
}): SpotQuote {
  const bps = input.feeBps ?? 10;
  const fee = "$0.00";
  const amount = Number(input.amount);
  const px = input.price;
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "amount", quantity: "", pay: "—", receive: "—", fee };
  if (!Number.isFinite(px) || px <= 0) return { ok: false, reason: "price", quantity: "", pay: "—", receive: "—", fee };
  const qty = input.mode === "usd" ? amount / px : amount;
  const quantity = trim(qty, input.qtyDecimals);
  const qtyN = Number(quantity);
  if (!qtyN) return { ok: false, reason: "amount", quantity: "", pay: "—", receive: "—", fee };
  const payUsd = input.mode === "usd" ? amount : qtyN * px;
  const pay = input.side === "buy" ? usd(payUsd) : `${quantity} ${input.unit}`;
  const receive = input.side === "buy" ? `${quantity} ${input.unit}` : usd(qtyN * px);
  const notional = input.side === "buy" ? payUsd : qtyN * px;
  const charged = usd((notional * bps) / 10_000);
  const short = input.side === "buy" ? payUsd > input.usdAvailable + 1e-6 : qtyN > input.baseAvailable + 1e-9;
  return { ok: !short, reason: short ? "funds" : null, quantity, pay, receive, fee: charged };
}

export function pctSpot(input: {
  side: "buy" | "sell";
  mode: AmountMode;
  pct: number;
  price: number;
  usdAvailable: number;
  baseAvailable: number;
  qtyDecimals: number;
}): string {
  const { side, mode, pct, price, usdAvailable, baseAvailable, qtyDecimals } = input;
  if (mode === "qty") {
    if (side === "sell") return trim(baseAvailable * pct, qtyDecimals);
    if (!(price > 0)) return "";
    return trim((usdAvailable * pct) / price, qtyDecimals);
  }
  if (side === "buy") return (Math.max(0, usdAvailable) * pct).toFixed(2);
  if (!(price > 0)) return "";
  return (Math.max(0, baseAvailable) * price * pct).toFixed(2);
}

export type LevQuote = SpotQuote & { marginUsd: number; notionalUsd: number; liq: number | null };

/** Isolated margin. 1× uses the full notional as margin. Liquidation uses the same floor as the server. */
export function quoteLeverage(input: {
  side: "buy" | "sell";
  mode: AmountMode;
  amount: string;
  price: number;
  leverage: number;
  freeUsd: number;
  qtyDecimals: number;
  unit: string;
  feeBps?: number;
}): LevQuote {
  const bps = input.feeBps ?? 10;
  const fee = "$0.00";
  const empty: LevQuote = { ok: false, reason: "amount", quantity: "", pay: "—", receive: "—", fee, marginUsd: 0, notionalUsd: 0, liq: null };
  const amount = Number(input.amount);
  const px = input.price;
  const lev = Math.max(1, input.leverage);
  if (!Number.isFinite(amount) || amount <= 0) return empty;
  if (!Number.isFinite(px) || px <= 0) return { ...empty, reason: "price" };
  let qty = 0;
  let marginUsd = 0;
  if (input.mode === "usd") {
    marginUsd = amount;
    qty = (marginUsd * lev) / px;
  } else {
    qty = amount;
    marginUsd = (qty * px) / lev;
  }
  const quantity = trim(qty, input.qtyDecimals);
  const qtyN = Number(quantity);
  if (!qtyN) return empty;
  const notionalUsd = qtyN * px;
  marginUsd = notionalUsd / lev;
  const floorLev = Math.max(lev, 1);
  const floor = notionalUsd / (2 * floorLev);
  const cushion = Math.max(0, marginUsd - floor);
  const move = notionalUsd > 0 ? cushion / notionalUsd : 0;
  const liq = input.side === "buy" ? px * (1 - move) : px * (1 + move);
  const pay = `$${marginUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const receive = `${quantity} ${input.unit}`;
  const short = marginUsd > input.freeUsd + 1e-6;
  return {
    ok: !short,
    reason: short ? "funds" : null,
    quantity,
    pay,
    receive,
    fee: usd((notionalUsd * bps) / 10_000),
    marginUsd,
    notionalUsd,
    liq: liq > 0 ? liq : null,
  };
}

export function pctLeverage(input: {
  mode: AmountMode;
  pct: number;
  price: number;
  leverage: number;
  freeUsd: number;
  qtyDecimals: number;
}): string {
  const lev = Math.max(1, input.leverage);
  if (input.mode === "usd") return (Math.max(0, input.freeUsd) * input.pct).toFixed(2);
  if (!(input.price > 0)) return "";
  return trim((Math.max(0, input.freeUsd) * input.pct * lev) / input.price, input.qtyDecimals);
}
