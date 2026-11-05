/** Integer units shared with the matching engine.
 *  qty: milligrams. price: USD cents per gram. cash: micro-USD.
 *  notional_uusd = qty_mg * price_cents_per_gram * 10.
 */

export function notionalUusd(qtyMg: bigint, priceCents: bigint): bigint {
  return qtyMg * priceCents * 10n;
}

export function parseScaled(input: string, scale: number): bigint {
  const s = input.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("VALIDATION");
  const [whole, frac = ""] = s.split(".");
  if (frac.length > scale) throw new Error("VALIDATION");
  const padded = (frac + "0".repeat(scale)).slice(0, scale);
  const digits = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  return BigInt(digits || "0");
}

export function formatScaled(amount: bigint, scale: number, decimals: number): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const base = 10n ** BigInt(scale);
  const whole = abs / base;
  const fracFull = (abs % base).toString().padStart(scale, "0");
  const frac = fracFull.slice(0, decimals).padEnd(decimals, "0");
  return `${neg ? "-" : ""}${whole.toString()}.${frac}`;
}

export const DEMO = {
  email: "client@meridexexchange.com",
  password: "<redacted>",
  totpSecret: "<redacted>",
  adminEmail: "compliance@meridexexchange.com",
  adminPassword: "<redacted>",
  adminTotpSecret: "<redacted>",
  ownerEmail: "founder@meridexexchange.com",
  ownerPassword: "<redacted>",
  ownerTotpSecret: "<redacted>",
};
