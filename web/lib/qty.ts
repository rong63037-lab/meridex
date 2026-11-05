export type UnitKey = "gram" | "kilogram" | "ounce" | "ticker";

export type QtySpec = {
  unitKey: UnitKey;
  ticker: string;
  defaultQty: string;
  step: string;
  min: string;
  scale: number;
  decimals: number;
};

const GRAMS = new Set(["XAU", "XAG", "XPT", "XPD"]);
const FX = new Set(["EUR", "GBP", "JPY", "AUD", "SGD", "MYR", "CNH", "HKD"]);
const COMMODITY = new Set(["BRENT", "WTI", "NATGAS", "COPPER", "ALUMINIUM", "NICKEL", "ZINC", "WHEAT", "CORN", "SOYBEAN", "COFFEE", "SUGAR"]);

/** Leading asset of XAU/USD, BTC-PERP, or a bare ticker. */
export function instrumentBase(symbol: string): string {
  const head = symbol.trim().toUpperCase().split(/[/-]/)[0] ?? "";
  return head;
}

function trimFixed(value: number, decimals: number): string {
  const text = value.toFixed(decimals);
  if (!text.includes(".")) return text;
  return text.replace(/\.?0+$/, "");
}

/** Quantity unit, step, and a default that stays a small amount of that asset. */
export function qtySpec(symbol: string): QtySpec {
  const base = instrumentBase(symbol);
  if (base === "XAUKG") {
    return { unitKey: "kilogram", ticker: "kg", defaultQty: "1", step: "1", min: "1", scale: 1, decimals: 0 };
  }
  if (base === "XAUOZ") {
    return { unitKey: "ounce", ticker: "oz", defaultQty: "0.100", step: "0.001", min: "0.100", scale: 1000, decimals: 3 };
  }
  if (GRAMS.has(base)) {
    return { unitKey: "gram", ticker: "g", defaultQty: "0.100", step: "0.001", min: "0.100", scale: 1000, decimals: 3 };
  }
  if (FX.has(base)) {
    return { unitKey: "ticker", ticker: base, defaultQty: "100", step: "1", min: "1", scale: 100, decimals: 2 };
  }
  if (base === "USDT" || base === "USDC") {
    return { unitKey: "ticker", ticker: base, defaultQty: "100", step: "1", min: "1", scale: 1_000_000, decimals: 2 };
  }
  if (base === "SHIB") {
    return { unitKey: "ticker", ticker: "SHIB", defaultQty: "1000000", step: "1000000", min: "1000000", scale: 1, decimals: 0 };
  }
  if (COMMODITY.has(base)) {
    return { unitKey: "ticker", ticker: base, defaultQty: "1", step: "1", min: "1", scale: 1000, decimals: 3 };
  }
  const whole = new Set(["XRP", "ADA", "DOGE", "TRX", "POL", "XLM", "ARB"]);
  const tenth = new Set(["AVAX", "DOT", "LINK", "TON", "NEAR", "ATOM", "UNI", "APT", "OP", "FIL", "ICP"]);
  let min = 0.01;
  let step = "0.01";
  let fallback = 0.1;
  if (base === "BTC" || base === "PAXG" || base === "XAUT") {
    min = 0.0001;
    step = "0.0001";
    fallback = 0.001;
  } else if (base === "ETH") {
    min = 0.001;
    step = "0.001";
    fallback = 0.01;
  } else if (whole.has(base)) {
    min = 1;
    step = "1";
    fallback = 1;
  } else if (tenth.has(base)) {
    min = 0.1;
    step = "0.1";
    fallback = 0.1;
  }
  return {
    unitKey: "ticker",
    ticker: base || "—",
    defaultQty: trimFixed(Math.max(min, fallback), 8),
    step,
    min: trimFixed(min, 8),
    scale: 100_000_000,
    decimals: 8,
  };
}

export function unitLabel(spec: QtySpec, words: { gram: string; kilogram: string; ounce: string }): string {
  if (spec.unitKey === "gram") return words.gram;
  if (spec.unitKey === "kilogram") return words.kilogram;
  if (spec.unitKey === "ounce") return words.ounce;
  return spec.ticker;
}

export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");
}

export function formatScaled(raw: string | number, scale: number, decimals: number): string {
  let n: bigint;
  try {
    n = BigInt(String(raw).split(".")[0] || "0");
  } catch {
    return String(raw);
  }
  const s = BigInt(scale);
  if (s <= 0n) return String(raw);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / s;
  if (decimals <= 0) return `${neg ? "-" : ""}${whole.toString()}`;
  const width = String(scale).length - 1;
  const frac = (abs % s).toString().padStart(width, "0").slice(0, decimals);
  return `${neg ? "-" : ""}${whole.toString()}.${frac}`;
}

function trimZeros(text: string): string {
  if (!text.includes(".")) return text;
  const trimmed = text.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "" || trimmed === "-" ? "0" : trimmed;
}

export function formatQtyWithUnit(
  symbol: string,
  raw: string | number,
  words: { gram: string; kilogram: string; ounce: string },
): string {
  const spec = qtySpec(symbol);
  return `${trimZeros(formatScaled(raw, spec.scale, spec.decimals))} ${unitLabel(spec, words)}`;
}
