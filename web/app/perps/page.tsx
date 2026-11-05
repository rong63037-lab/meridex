"use client";

import { useEffect, useState } from "react";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { EmptyMark } from "@/components/EmptyMark";
import { api } from "@/lib/api";
import { centsToUsd, formatUsd, timeLabel } from "@/lib/format";
import { useI18n, reasonText } from "@/lib/i18n";
import { DeskLoading } from "@/components/ComingSoon";
import { LiveDesk } from "@/components/LiveDesk";
import { fillTemplate, formatScaled, qtySpec, unitLabel } from "@/lib/qty";
import { pctLeverage, quoteLeverage, type AmountMode } from "@/lib/simple-math";
import { SimpleOrder } from "@/components/SimpleOrder";
import { ReferenceDepth } from "@/components/ReferenceDepth";
import { usePaperMode } from "@/lib/usePaper";

type Market = { symbol: string; mark: string; index: string; fundingBps: number; fundingAt: string };
type Pos = {
  id: string;
  symbol: string;
  side: string;
  qty: string;
  entry_px: string;
  leverage: number;
  margin_uusd: string;
  status: string;
  realized_uusd: string;
};
type Board = { access: string; markets: Market[]; positions: Pos[] };

export default function PerpsPage() {
  const { t, lang } = useI18n();
  const { paper, ready } = usePaperMode();
  const [board, setBoard] = useState<Board | null>(null);
  const [symbol, setSymbol] = useState("XAU-PERP");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [qty, setQty] = useState(qtySpec("XAU-PERP").defaultQty);
  const [lev, setLev] = useState(3);
  const [tp, setTp] = useState("");
  const [sl, setSl] = useState("");
  const [error, setError] = useState("");
  const [amountMode, setAmountMode] = useState<AmountMode>("usd");
  const [spend, setSpend] = useState("");
  const [confirmOrder, setConfirmOrder] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [freeUsd, setFreeUsd] = useState(0);

  function load() {
    api<Board>("/api/perps").then(setBoard).catch((err) => setError(reasonText(lang, (err as Error).message)));
  }
  useEffect(() => { if (paper) load(); }, [paper]);
  useEffect(() => {
    setAdvanced(localStorage.getItem("meridex.liveAdvanced") === "1");
  }, []);
  useEffect(() => {
    if (!paper) return;
    api<{ balances?: { USD?: { available?: string } } }>("/api/paper")
      .then((res) => setFreeUsd(Number(res.balances?.USD?.available ?? 0) / 1_000_000))
      .catch(() => undefined);
  }, [paper, board]);

  const words = { gram: t.unitGram, kilogram: t.unitKg, ounce: t.unitOz };
  const spec = qtySpec(symbol);
  const unit = unitLabel(spec, words);

  function choose(next: string) {
    setSymbol(next);
    setQty(qtySpec(next).defaultQty);
  }

  const locked = board != null && board.access !== "allow";
  const us = board?.access === "US_RETAIL_BLOCK";

  if (!ready) return <DeskLoading />;
  if (!paper) return <LiveDesk product="perp" />;

  return (
    <Shell>
      <div className="page">
        <section className="panel">
          <span className="sim-flag">{t.licenceBadge}</span>
          <h1>{t.perpTitle}</h1>
          <p className="hint">{t.perpBody}</p>
          <p className="paper-banner">{t.paperBanner}</p>
          {us ? <p className="err">{t.marginHardUs}</p> : null}
        </section>
        <div className="cards">
          {(board?.markets ?? []).map((mkt) => (
            <article key={mkt.symbol} className={`card ${symbol === mkt.symbol ? "on" : ""}`} onClick={() => choose(mkt.symbol)}>
              <h3>{mkt.symbol}</h3>
              <div className="num">{centsToUsd(mkt.mark)}</div>
              <p className="hint">{t.perpIndex} {centsToUsd(mkt.index)}</p>
              <p className="hint">{t.perpFunding} {(mkt.fundingBps / 100).toFixed(2)}% · {timeLabel(mkt.fundingAt)}</p>
            </article>
          ))}
        </div>
        {us ? null : (
        <section className="panel">
          <SimpleOrder
            symbols={(board?.markets ?? [{ symbol }]).map((item) => ({ symbol: item.symbol }))}
            symbol={symbol}
            onSymbol={choose}
            side={side}
            onSide={setSide}
            buyLabel={t.buy}
            sellLabel={t.sell}
            amount={advanced ? qty : spend}
            onAmount={advanced ? setQty : setSpend}
            amountMode={advanced ? "qty" : amountMode}
            onAmountMode={setAmountMode}
            unit={unit}
            onPct={(pct) => {
              const mark = Number(board?.markets.find((item) => item.symbol === symbol)?.mark ?? 0) / 100;
              const next = pctLeverage({ mode: amountMode, pct, price: mark, leverage: advanced ? lev : Math.min(lev, 3), freeUsd, qtyDecimals: spec.decimals });
              if (advanced) setQty(next);
              else setSpend(next);
            }}
            pay={quoteLeverage({ side, mode: advanced ? "qty" : amountMode, amount: advanced ? qty : spend, price: Number(board?.markets.find((item) => item.symbol === symbol)?.mark ?? 0) / 100, leverage: advanced ? lev : Math.min(Math.max(lev, 1), 3), freeUsd, qtyDecimals: spec.decimals, unit }).pay}
            receive={quoteLeverage({ side, mode: advanced ? "qty" : amountMode, amount: advanced ? qty : spend, price: Number(board?.markets.find((item) => item.symbol === symbol)?.mark ?? 0) / 100, leverage: advanced ? lev : Math.min(Math.max(lev, 1), 3), freeUsd, qtyDecimals: spec.decimals, unit }).receive}
            fee={quoteLeverage({ side, mode: advanced ? "qty" : amountMode, amount: advanced ? qty : spend, price: Number(board?.markets.find((item) => item.symbol === symbol)?.mark ?? 0) / 100, leverage: advanced ? lev : Math.min(Math.max(lev, 1), 3), freeUsd, qtyDecimals: spec.decimals, unit, feeBps: 5 }).fee}
            funds={Boolean(spend || qty) && quoteLeverage({ side, mode: advanced ? "qty" : amountMode, amount: advanced ? qty : spend, price: Number(board?.markets.find((item) => item.symbol === symbol)?.mark ?? 0) / 100, leverage: advanced ? lev : Math.min(Math.max(lev, 1), 3), freeUsd, qtyDecimals: spec.decimals, unit }).reason === "funds"}
            error={error}
            goLabel={t.perpOpen}
            leverage={{ value: advanced ? lev : Math.min(Math.max(lev, 1), 3), min: 1, max: advanced ? 10 : 3, onChange: setLev }}
            liq={(() => {
              const row = quoteLeverage({ side, mode: advanced ? "qty" : amountMode, amount: advanced ? qty : spend, price: Number(board?.markets.find((item) => item.symbol === symbol)?.mark ?? 0) / 100, leverage: advanced ? lev : Math.min(Math.max(lev, 1), 3), freeUsd, qtyDecimals: spec.decimals, unit });
              return row.liq == null ? "" : fillTemplate(t.liqPlain, { px: row.liq.toLocaleString("en-US", { maximumFractionDigits: 2 }) });
            })()}
            risk={t.levRisk}
            advancedOpen={advanced}
            onAdvanced={(open) => {
              setAdvanced(open);
              localStorage.setItem("meridex.liveAdvanced", open ? "1" : "0");
            }}
            advanced={advanced ? (
              <div className="split">
                <div><label>{t.perpTp}</label><input className="desk-input" value={tp} onChange={(e) => setTp(e.target.value)} /></div>
                <div><label>{t.perpSl}</label><input className="desk-input" value={sl} onChange={(e) => setSl(e.target.value)} /></div>
              </div>
            ) : null}
            onGo={() => setConfirmOrder(true)}
            confirmOpen={confirmOrder}
            confirmBody={`${side === "buy" ? t.buy : t.sell} ${symbol}`}
            onConfirmNo={() => setConfirmOrder(false)}
            onConfirmYes={() => {
              setConfirmOrder(false);
              const mark = Number(board?.markets.find((item) => item.symbol === symbol)?.mark ?? 0) / 100;
              const row = quoteLeverage({ side, mode: advanced ? "qty" : amountMode, amount: advanced ? qty : spend, price: mark, leverage: advanced ? lev : Math.min(Math.max(lev, 1), 3), freeUsd, qtyDecimals: spec.decimals, unit });
              if (!row.quantity) {
                setError(row.reason === "funds" ? t.needDeposit : t.liveBadQty);
                return;
              }
              setQty(row.quantity);
              void api("/api/perps/orders", {
                method: "POST",
                body: JSON.stringify({ symbol, side, quantity: row.quantity, leverage: advanced ? lev : Math.min(Math.max(lev, 1), 3), tp: advanced ? tp || null : null, sl: advanced ? sl || null : null }),
              }).then(() => load()).catch((err) => setError(reasonText(lang, (err as Error).message)));
            }}
          />
          <p className="hint">{fillTemplate(t.qtyWithUnit, { unit })} · {fillTemplate(t.qtyMin, { n: spec.min, unit })}</p>
          {locked ? <p className="hint">{t.categoryPending}</p> : null}
        </section>
        )}
        <ReferenceDepth symbol={symbol} />
        <section className="panel">
          <h2>{t.positions}</h2>
          {(board?.positions ?? []).length === 0 ? <div className="empty-chart"><EmptyMark /><p>{t.perpEmpty}</p></div> : (
            <table className="table">
              <thead><tr><th></th><th>{t.side}</th><th>{t.last}</th><th></th><th>{t.pnl}</th><th></th></tr></thead>
              <tbody>
                {board?.positions.map((pos) => (
                  <tr key={pos.id}>
                    <td>{pos.symbol} · {formatScaled(pos.qty, qtySpec(pos.symbol).scale, qtySpec(pos.symbol).decimals)} {unitLabel(qtySpec(pos.symbol), words)} · {pos.leverage}×</td>
                    <td className={pos.side === "buy" ? "up" : "down"}>{pos.side}</td>
                    <td className="num">{centsToUsd(pos.entry_px)}</td>
                    <td>{pos.status}</td>
                    <td className="num">{formatUsd(pos.realized_uusd)}</td>
                    <td>{pos.status === "open" ? <Button size="sm" variant="outline" disabled={locked} onClick={() => api(`/api/perps/${pos.id}/close`, { method: "POST", body: "{}" }).then(load)}>{t.perpClose}</Button> : null}</td>
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
