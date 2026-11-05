import { getInstrument } from "../instruments.js";
import type { ProviderRow } from "./types.js";

export function toScaled(text: string, scale: number): bigint | null {
  const raw = text.trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const [whole, frac = ""] = raw.split(".");
  const digits = Math.max(0, String(scale).length - 1);
  const padded = (frac + "0".repeat(digits)).slice(0, digits);
  const fracN = padded ? BigInt(padded) : 0n;
  return BigInt(whole) * BigInt(scale) + fracN;
}

export function fromScaled(qty: bigint, scale: number): string {
  const neg = qty < 0n;
  const value = neg ? -qty : qty;
  const unit = BigInt(scale);
  const whole = value / unit;
  const digits = Math.max(0, String(scale).length - 1);
  if (digits === 0) return `${neg ? "-" : ""}${whole}`;
  const frac = (value % unit).toString().padStart(digits, "0").replace(/0+$/, "");
  const text = frac ? `${whole}.${frac}` : whole.toString();
  return neg ? `-${text}` : text;
}

export function scalesFor(row: ProviderRow, symbol: string): { qty: number; price: number } {
  const names = [symbol];
  for (const [internal, venue] of Object.entries(row.symbolMap)) {
    if (venue === symbol) names.push(internal);
  }
  for (const name of names) {
    try {
      const inst = getInstrument(name);
      return { qty: inst.qtyScale, price: inst.priceScale };
    } catch {
      /* try the next name */
    }
  }
  return { qty: 100_000_000, price: 100 };
}
