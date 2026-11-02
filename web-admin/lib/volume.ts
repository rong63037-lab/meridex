export type GlobalQuote = {
  kind: "aggregate" | "exchange" | "futures" | "otc" | "none";
  source: string | null;
  volumeBase: number | null;
  volumeUsd: number | null;
  high: number | null;
  low: number | null;
  last: number | null;
  change: number | null;
  updatedAt: number | null;
  delayed: boolean;
  note: string;
};

export function compactUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

export function clock(ms: number | null | undefined): string {
  if (!ms) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function globalLabel(row: GlobalQuote | undefined, otc: string): string {
  if (!row) return "—";
  if (row.kind === "otc") return otc;
  if (row.volumeUsd == null) return "—";
  return compactUsd(row.volumeUsd);
}
