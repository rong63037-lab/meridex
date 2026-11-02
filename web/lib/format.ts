const TROY_OZ_G = 31.1034768;

export function centsToUsd(cents: number | string | null | undefined): string {
  if (cents === null || cents === undefined || cents === "") return "—";
  const n = Number(cents);
  return `$${(n / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function approxOz(cents: number | string | null | undefined): string {
  if (cents === null || cents === undefined || cents === "") return "—";
  const usdPerG = Number(cents) / 100;
  return `$${(usdPerG * TROY_OZ_G).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

export function mgToGrams(mg: string | number | bigint): string {
  const n = BigInt(mg);
  const sign = n < 0n ? "-" : "";
  const abs = n < 0n ? -n : n;
  const whole = abs / 1000n;
  const frac = (abs % 1000n).toString().padStart(3, "0");
  return `${sign}${whole.toLocaleString("en-US")}.${frac}`;
}

export function formatUsd(uusd: string | number | bigint): string {
  const n = BigInt(uusd);
  const sign = n < 0n ? "-" : "";
  const abs = n < 0n ? -n : n;
  const dollars = abs / 1_000_000n;
  const cents = (abs / 10_000n) % 100n;
  return `${sign}$${dollars.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
}

export function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
