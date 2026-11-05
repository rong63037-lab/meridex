"use client";

import { useEffect, useState } from "react";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { EmptyMark } from "@/components/EmptyMark";
import { api } from "@/lib/api";
import { centsToUsd, formatUsd, timeLabel } from "@/lib/format";
import { useI18n, reasonText } from "@/lib/i18n";
import { fillTemplate, qtySpec, unitLabel } from "@/lib/qty";
import { usePaperMode } from "@/lib/usePaper";

type Inst = { symbol: string; status: string; priceDecimals: number; qtyDecimals: number };
type Quote = {
  quoteId: string;
  symbol: string;
  side: string;
  price: string;
  notionalUusd: string;
  feeUusd: string;
  feeBps: number;
  spreadBps: number;
  slippageBps: number;
  expiresAt: string;
  namespace: string;
};
type Fill = {
  quoteId: string;
  symbol: string;
  side: string;
  filled: string;
  price: string;
  notionalUusd: string;
  feeUusd: string;
  path: string;
  namespace: string;
  createdAt: string;
};

export default function ConvertPage() {
  const { t, lang } = useI18n();
  const { paper } = usePaperMode();
  const [symbols, setSymbols] = useState<string[]>(["XAU/USD"]);
  const [symbol, setSymbol] = useState("XAU/USD");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [qty, setQty] = useState(qtySpec("XAU/USD").defaultQty);
  const [slip, setSlip] = useState(30);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [left, setLeft] = useState(0);
  const [fills, setFills] = useState<Fill[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function loadHistory() {
    api<{ fills: Fill[] }>("/api/convert/history").then((res) => setFills(res.fills)).catch(() => undefined);
  }

  useEffect(() => {
    api<{ instruments: Inst[] }>("/api/market/instruments")
      .then((res) => {
        const names = res.instruments.filter((row) => row.status === "trading").map((row) => row.symbol);
        if (names.length) setSymbols(names);
      })
      .catch(() => undefined);
    loadHistory();
  }, []);

  useEffect(() => {
    if (!quote) return;
    const tick = () => setLeft(Math.max(0, Math.ceil((new Date(quote.expiresAt).getTime() - Date.now()) / 1000)));
    tick();
    const id = window.setInterval(tick, 200);
    return () => window.clearInterval(id);
  }, [quote]);

  async function requestQuote() {
    setBusy(true);
    setError("");
    try {
      const next = await api<Quote>("/api/convert/quote", {
        method: "POST",
        body: JSON.stringify({ symbol, side, quantity: qty, slippageBps: slip, paper }),
      });
      setQuote(next);
    } catch (err) {
      setQuote(null);
      setError(reasonText(lang, (err as Error).message));
    } finally {
      setBusy(false);
    }
  }

  async function execute() {
    if (!quote) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/convert/execute", { method: "POST", body: JSON.stringify({ quoteId: quote.quoteId }) });
      setQuote(null);
      loadHistory();
    } catch (err) {
      setError(reasonText(lang, (err as Error).message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <div className="page">
        <section className="panel">
          <div className="kicker">{paper ? t.paperMode : t.modeReal}</div>
          <h1>{t.convertTitle}</h1>
          <p className="hint">{t.convertBody}</p>
        </section>
        <section className="split">
          <form
            className="panel"
            onSubmit={(e) => {
              e.preventDefault();
              void requestQuote();
            }}
          >
            <label>{t.symbol}</label>
            <select className="desk-input" value={symbol} onChange={(e) => { setSymbol(e.target.value); setQty(qtySpec(e.target.value).defaultQty); setQuote(null); }}>
              {symbols.map((name) => <option key={name}>{name}</option>)}
            </select>
            <div className="side-toggle" style={{ marginTop: 12 }}>
              <button type="button" className={`buy ${side === "buy" ? "on" : ""}`} onClick={() => setSide("buy")}>{t.bid}</button>
              <button type="button" className={`sell ${side === "sell" ? "on" : ""}`} onClick={() => setSide("sell")}>{t.ask}</button>
            </div>
            <label>{fillTemplate(t.qtyWithUnit, { unit: unitLabel(qtySpec(symbol), { gram: t.unitGram, kilogram: t.unitKg, ounce: t.unitOz }) })}</label>
            <input className="desk-input" value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" step={qtySpec(symbol).step} />
            <p className="hint">{fillTemplate(t.qtyMin, { n: qtySpec(symbol).min, unit: unitLabel(qtySpec(symbol), { gram: t.unitGram, kilogram: t.unitKg, ounce: t.unitOz }) })}</p>
            <label>{t.convertSlip} · {slip} bps</label>
            <input type="range" min={5} max={100} value={slip} onChange={(e) => setSlip(Number(e.target.value))} />
            {error ? <p className="err">{error}</p> : null}
            <Button type="submit" disabled={busy}>{quote ? t.convertRefresh : t.convertGet}</Button>
          </form>
          <aside className="panel quote-card">
            {quote ? (
              <>
                <div className="quote-count">{left}s</div>
                <div className="hint">{t.convertRate}</div>
                <div className="px">{centsToUsd(quote.price)}</div>
                <p className="hint">{t.convertFirm}</p>
                <p>{t.convertFee} {formatUsd(quote.feeUusd)} · {quote.feeBps} bps · spread {quote.spreadBps} bps</p>
                <p className="hint">{t.notional} {formatUsd(quote.notionalUusd)} · {quote.namespace === "paper" ? t.paperNamespace : t.realNamespace}</p>
                <Button disabled={busy || left <= 0} onClick={() => void execute()}>{t.convertExecute}</Button>
              </>
            ) : (
              <p className="hint">{t.convertFirm}</p>
            )}
          </aside>
        </section>
        <section className="panel">
          <h2>{t.convertHistory}</h2>
          {fills.length === 0 ? (
            <div className="empty-chart"><EmptyMark /><p>{t.convertEmpty}</p></div>
          ) : (
            <table className="table">
              <thead><tr><th>{t.time}</th><th></th><th>{t.side}</th><th>{t.convertRate}</th><th>{t.convertFee}</th><th></th></tr></thead>
              <tbody>
                {fills.map((row) => (
                  <tr key={row.quoteId}>
                    <td>{timeLabel(row.createdAt)}</td>
                    <td>{row.symbol}</td>
                    <td className={row.side === "buy" ? "up" : "down"}>{row.side}</td>
                    <td className="num">{centsToUsd(row.price)}</td>
                    <td className="num">{formatUsd(row.feeUusd)}</td>
                    <td>{row.path} · {row.namespace === "paper" ? t.paperNamespace : t.realNamespace}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </Shell>
  );
}
