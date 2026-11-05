"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

// Subset of /api/market/tickers (the platform's own market data) used by 行情资讯.
export type MiniTicker = {
  symbol: string; nameZh: string; nameEn: string; category: "metal" | "crypto" | "commodity" | "fx";
  last: number; change: number; priceScale: number; priceDecimals: number;
  venueVolumeUsd?: number; high?: number; low?: number;
};

export function useTickers(ms = 5000) {
  const [rows, setRows] = useState<MiniTicker[]>([]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const pull = () => api<MiniTicker[]>("/api/market/tickers").then((r) => { setRows(r); setReady(true); }).catch(() => setReady(true));
    pull();
    const id = window.setInterval(pull, ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return { rows, ready };
}

export function px(row: MiniTicker): string {
  const v = row.last / row.priceScale;
  return v.toLocaleString("en-US", { minimumFractionDigits: row.priceDecimals, maximumFractionDigits: row.priceDecimals });
}
export function pct(change: number): string {
  const v = change * 100;
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}
export function usdShort(v: number | undefined): string {
  if (!v) return "—";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}
