"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { StatusMark } from "@/components/StatusMark";
import { useI18n } from "@/lib/i18n";
import { formatPx } from "@/lib/markets";
import { DEFAULT_WATCH, useWatchlist } from "@/lib/watchlist";
import { terminalHref } from "@/lib/symbol";

type Row = {
  symbol: string;
  last: number;
  change: number;
  priceScale: number;
  priceDecimals: number;
  halted?: boolean;
  liquidity?: "low" | "ok";
  regulatoryTag?: string;
  category?: string;
  status?: string;
};

export function WatchStrip({ rows }: { rows: Row[] }) {
  const { t } = useI18n();
  const { watch, replace } = useWatchlist();
  const shown = rows.filter((row) => watch.includes(row.symbol));

  if (watch.length === 0) {
    return (
      <div className="empty-watch">
        <p>{t.watchEmpty}</p>
        <Button type="button" onClick={() => replace(DEFAULT_WATCH)}>{t.watchCta}</Button>
      </div>
    );
  }

  return (
    <div className="ticker">
      {shown.map((row) => {
        const pending = row.category !== "metal" || row.status === "halted";
        return (
          <Link key={row.symbol} href={terminalHref(row.symbol)} data-symbol={row.symbol} className="tick-card">
            <header>
              <span>{row.symbol}</span>
              <StatusMark halted={row.halted} pending={pending && row.category !== "metal"} liquidity={row.liquidity} tag={row.regulatoryTag} />
            </header>
            <b className={row.change >= 0 ? "up" : "down"}>{formatPx(row.last / row.priceScale, row.priceDecimals)}</b>
          </Link>
        );
      })}
    </div>
  );
}
