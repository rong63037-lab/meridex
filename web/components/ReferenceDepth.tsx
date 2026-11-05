"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { fillTemplate } from "@/lib/qty";

type Level = { price: string; size: string };
type Print = { price: string; size: string; side: "buy" | "sell"; time: string };
type View = {
  enabled: boolean;
  symbol?: string;
  spot?: string;
  source?: string;
  kind?: "book" | "price" | "none";
  bids?: Level[];
  asks?: Level[];
  trades?: Print[];
  price?: string | null;
  unit?: string;
  asOf?: number;
  staleAfterMs?: number;
  stale?: boolean;
};

const NAMES: Record<string, string> = {
  binance: "Binance",
  coinbase: "Coinbase",
  kraken: "Kraken",
  coingecko: "CoinGecko",
  "gold-api": "Gold API",
  frankfurter: "Frankfurter",
};

export function ReferenceDepth({ symbol }: { symbol: string }) {
  const { t } = useI18n();
  const [view, setView] = useState<View | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    let stop = false;
    let timer = 0;
    const pull = async () => {
      try {
        const res = await api<View>(`/api/market/reference?symbol=${encodeURIComponent(symbol)}`);
        if (stop) return;
        setView(res);
        if (!res.enabled) return;
        timer = window.setTimeout(() => void pull(), 2000);
      } catch {
        if (stop) return;
        timer = window.setTimeout(() => void pull(), 4000);
      }
    };
    void pull();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [symbol]);

  useEffect(() => {
    if (!view?.enabled) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [view?.enabled, view?.asOf]);

  if (!view?.enabled) return null;

  const limit = view.staleAfterMs ?? 4000;
  const stale = Boolean(view.stale || (view.asOf && now && now - view.asOf > limit));
  const source = NAMES[view.source || ""] || view.source || "";
  const unit = view.unit || "";

  return (
    <section className="panel ref-depth" data-testid="reference-depth" aria-label={t.refTitle}>
      <h2>{t.refTitle}</h2>
      <p className="ref-disclaimer">{t.refDisclaimer}</p>
      {view.symbol && view.spot && view.symbol !== view.spot ? <p className="hint">{fillTemplate(t.refPerp, { spot: view.spot })}</p> : null}
      <p className="hint">{fillTemplate(t.refSource, { name: source || "—" })}{unit ? ` · ${fillTemplate(t.refUnit, { unit })}` : ""}</p>
      {stale && view.kind !== "none" ? <p className="ref-stale" data-testid="reference-stale">{t.refStale}</p> : null}
      {view.kind === "none" ? <p className="hint">{t.refDown}</p> : null}
      {view.kind === "price" ? (
        <>
          <p className="hint">{t.refPriceOnly}</p>
          <p className="ref-price num">{view.price ?? "—"}</p>
        </>
      ) : null}
      {view.kind === "book" ? (
        <>
          <div className="ref-grid">
            <div>
              <h3>{t.refBids}</h3>
              {(view.bids ?? []).map((row) => (
                <div className="ref-row bid" key={`b${row.price}${row.size}`}>
                  <span>{row.price}</span>
                  <span>{row.size} {unit}</span>
                </div>
              ))}
              {(view.bids ?? []).length === 0 ? <p className="hint">—</p> : null}
            </div>
            <div>
              <h3>{t.refAsks}</h3>
              {(view.asks ?? []).map((row) => (
                <div className="ref-row ask" key={`a${row.price}${row.size}`}>
                  <span>{row.price}</span>
                  <span>{row.size} {unit}</span>
                </div>
              ))}
              {(view.asks ?? []).length === 0 ? <p className="hint">—</p> : null}
            </div>
          </div>
          {(view.trades ?? []).length ? (
            <div className="ref-prints">
              <h3>{t.refPrints}</h3>
              {(view.trades ?? []).map((row, index) => (
                <div className={`ref-row ${row.side}`} key={`${row.time}${row.price}${index}`}>
                  <span>{row.price}</span>
                  <span>{row.size} {unit}</span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
