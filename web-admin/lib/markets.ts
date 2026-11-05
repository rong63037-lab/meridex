import type { TapeTrade } from "./api";

export const TROY_OZ_G = 31.1034768;

export type MetalCode = "XAU" | "XAG" | "XPT" | "XPD";

export type Metal = {
  code: MetalCode;
  symbol: string;
  ratio: number;
  tradable: boolean;
};

/** Legacy display ratios. Live trading uses the instrument catalog, not this list. */
export const METALS: Metal[] = [
  { code: "XAU", symbol: "XAU/USD", ratio: 1, tradable: true },
  { code: "XAG", symbol: "XAG/USD", ratio: 1 / 82, tradable: false },
  { code: "XPT", symbol: "XPT/USD", ratio: 0.45, tradable: false },
  { code: "XPD", symbol: "XPD/USD", ratio: 0.42, tradable: false },
];

export const TIMEFRAMES = [
  { id: "1m", sec: 60 },
  { id: "5m", sec: 300 },
  { id: "15m", sec: 900 },
  { id: "1H", sec: 3600 },
  { id: "4H", sec: 14400 },
  { id: "1D", sec: 86400 },
] as const;

export type Print = { t: number; price: number; qtyG: number; id: string };

export function mergePrints(chart: TapeTrade[], trades: TapeTrade[]): Print[] {
  const map = new Map<string, TapeTrade>();
  for (const row of chart) map.set(row.engine_trade_id, row);
  for (const row of trades) map.set(row.engine_trade_id, row);
  return [...map.values()]
    .map((row) => ({
      id: row.engine_trade_id,
      t: new Date(row.tape_at).getTime() / 1000,
      price: Number(row.price_cents) / 100,
      qtyG: Number(row.qty_mg) / 1000,
    }))
    .filter((row) => Number.isFinite(row.t) && Number.isFinite(row.price))
    .sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
}

export function scalePrints(prints: Print[], ratio: number): Print[] {
  if (ratio === 1) return prints;
  return prints.map((row) => ({ ...row, price: row.price * ratio, qtyG: 0 }));
}

export type Stats = { open: number; last: number; high: number; low: number; change: number; volume: number };

export function sessionStats(prints: Print[]): Stats | null {
  if (!prints.length) return null;
  let high = prints[0].price;
  let low = prints[0].price;
  let volume = 0;
  for (const row of prints) {
    if (row.price > high) high = row.price;
    if (row.price < low) low = row.price;
    volume += row.qtyG;
  }
  const open = prints[0].price;
  const last = prints[prints.length - 1].price;
  return { open, last, high, low, change: open ? (last - open) / open : 0, volume };
}

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

export function toCandles(prints: Print[], tfSec: number): Candle[] {
  const buckets = new Map<number, Candle>();
  for (const row of prints) {
    const time = Math.floor(row.t / tfSec) * tfSec;
    const bar = buckets.get(time);
    if (!bar) {
      buckets.set(time, { time, open: row.price, high: row.price, low: row.price, close: row.price, volume: row.qtyG });
    } else {
      bar.high = Math.max(bar.high, row.price);
      bar.low = Math.min(bar.low, row.price);
      bar.close = row.price;
      bar.volume += row.qtyG;
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

export function movingAverage(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out.push(i + 1 >= period ? sum / period : null);
  }
  return out;
}

export function digitsFor(price: number): number {
  if (price >= 20) return 2;
  if (price >= 1) return 3;
  return 4;
}

export function fromScale(amount: number | string | null | undefined, scale: number, decimals: number): string {
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return (n / scale).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function formatPx(price: number | null | undefined, digits?: number): string {
  if (price === null || price === undefined || !Number.isFinite(price)) return "—";
  const d = digits ?? digitsFor(price);
  return price.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function formatPct(change: number | null | undefined): string {
  if (change === null || change === undefined || !Number.isFinite(change)) return "—";
  const sign = change > 0 ? "+" : "";
  return `${sign}${(change * 100).toFixed(2)}%`;
}

export function sparkPath(values: number[], w = 96, h = 28): string {
  if (values.length < 2) return "";
  let min = values[0];
  let max = values[0];
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const span = Math.max(1e-9, max - min);
  return values
    .map((value, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((value - min) / span) * (h - 2) - 1;
      return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}
