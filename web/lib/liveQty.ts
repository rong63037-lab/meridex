import { formatScaled, instrumentBase, qtySpec } from "./qty";

/** Client-side size rules that match the gateway: min quantity, decimal step, and price tick. */
export type LiveQty = {
  scale: number;
  decimals: number;
  minRaw: bigint;
  stepRaw: bigint;
  tick: bigint;
  minText: string;
  stepText: string;
  tickText: string;
};

const TICK_CENTS: Record<string, bigint> = {
  BTC: 100n,
  ETH: 10n,
  XAU: 1n,
  XAG: 1n,
};

function trimZeros(text: string): string {
  if (!text.includes(".")) return text;
  const trimmed = text.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "" || trimmed === "-" ? "0" : trimmed;
}

export function liveQty(symbol: string): LiveQty {
  const spec = qtySpec(symbol);
  const den = 10 ** spec.decimals;
  const stepRaw = BigInt(Math.max(1, Math.round(spec.scale / den)));
  const minRaw = BigInt(Math.round(Number(spec.min) * spec.scale));
  const tick = TICK_CENTS[instrumentBase(symbol)] ?? 1n;
  return {
    scale: spec.scale,
    decimals: spec.decimals,
    minRaw,
    stepRaw,
    tick,
    minText: spec.min,
    stepText: trimZeros(formatScaled(stepRaw.toString(), spec.scale, spec.decimals)),
    tickText: `$${(Number(tick) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  };
}

export type QtyParse = { ok: true; raw: bigint } | { ok: false; reason: "format" | "min" | "step" };

export function parseLiveQty(text: string, spec: LiveQty): QtyParse {
  const s = text.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, reason: "format" };
  const [whole, frac = ""] = s.split(".");
  if (frac.length > spec.decimals) return { ok: false, reason: "step" };
  const padded = (frac + "0".repeat(spec.decimals)).slice(0, spec.decimals);
  const digits = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  const raw = BigInt(digits || "0");
  if (raw <= 0n) return { ok: false, reason: "format" };
  if (raw < spec.minRaw) return { ok: false, reason: "min" };
  if (spec.stepRaw > 0n && raw % spec.stepRaw !== 0n) return { ok: false, reason: "step" };
  return { ok: true, raw };
}

export type PriceParse = { ok: true; cents: bigint } | { ok: false; reason: "format" | "tick" };

export function parseLivePrice(text: string, spec: LiveQty): PriceParse {
  const s = text.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, reason: "format" };
  const [whole, frac = ""] = s.split(".");
  if (frac.length > 2) return { ok: false, reason: "tick" };
  const padded = (frac + "00").slice(0, 2);
  const digits = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  const cents = BigInt(digits || "0");
  if (cents <= 0n) return { ok: false, reason: "format" };
  if (spec.tick > 0n && cents % spec.tick !== 0n) return { ok: false, reason: "tick" };
  return { ok: true, cents };
}

export type UsdParse = { ok: true; micro: bigint } | { ok: false; reason: "format" | "zero" };

/** USD text to micro-USD. At most 6 decimal places, matching the ledger parser. */
export function parseUsdMicro(text: string): UsdParse {
  const s = text.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) return { ok: false, reason: "format" };
  const [whole, frac = ""] = s.split(".");
  const padded = (frac + "000000").slice(0, 6);
  const digits = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  const micro = BigInt(digits || "0");
  if (micro <= 0n) return { ok: false, reason: "zero" };
  return { ok: true, micro };
}
