"use client";

import { useEffect, useState } from "react";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { centsToUsd, formatUsd, timeLabel } from "@/lib/format";
import { useI18n, reasonText } from "@/lib/i18n";
import { DeskLoading } from "@/components/ComingSoon";
import { LiveCopy } from "@/components/LiveCopy";
import { formatQtyWithUnit } from "@/lib/qty";
import { usePaperMode } from "@/lib/usePaper";

type Leader = {
  id: string;
  nameZh: string;
  nameEn: string;
  styleZh: string;
  styleEn: string;
  winRate: number;
  drawdown: number;
  fictional: boolean;
  curve: number[];
};
type Follow = { leader_id: string; allocation_uusd: string; max_drawdown_bps: number; status: string };
type Trade = { id: string; leader_id: string; symbol: string; side: string; qty: string; price_px: string; created_at: string };

export default function CopyPage() {
  const { t, lang } = useI18n();
  const { paper, ready } = usePaperMode();
  const [leaders, setLeaders] = useState<Leader[]>([]);
  const [follows, setFollows] = useState<Follow[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [alloc, setAlloc] = useState("500.00");
  const [dd, setDd] = useState(800);
  const [error, setError] = useState("");

  function load() {
    api<{ leaders: Leader[]; follows: Follow[]; trades: Trade[] }>("/api/copy")
      .then((res) => {
        setLeaders(res.leaders);
        setFollows(res.follows);
        setTrades(res.trades);
      })
      .catch((err) => setError(reasonText(lang, (err as Error).message)));
  }
  useEffect(() => { if (paper) load(); }, [paper]);

  async function follow(leaderId: string) {
    setError("");
    try {
      await api("/api/copy/follow", {
        method: "POST",
        body: JSON.stringify({ leaderId, allocation: alloc, maxDrawdownBps: dd }),
      });
      load();
    } catch (err) {
      setError(reasonText(lang, (err as Error).message));
    }
  }

  if (!ready) return <DeskLoading />;
  if (!paper) return <LiveCopy />;

  const words = { gram: t.unitGram, kilogram: t.unitKg, ounce: t.unitOz };

  return (
    <Shell>
      <div className="page">
        <section className="panel">
          <span className="sim-flag">{t.licenceBadge}</span>
          <h1>{t.copyTitle}</h1>
          <p className="hint">{t.copyBody}</p>
          <p className="hint">{t.copyDisclaimer}</p>
          <p className="paper-banner">{t.paperBanner}</p>
        </section>
        <div className="split">
          <label>{t.copyAlloc}<input className="desk-input" value={alloc} onChange={(e) => setAlloc(e.target.value)} /></label>
          <label>{t.copyDrawdown} · {(dd / 100).toFixed(0)}%<input type="range" min={100} max={2000} step={50} value={dd} onChange={(e) => setDd(Number(e.target.value))} /></label>
        </div>
        {error ? <p className="err">{error}</p> : null}
        <div className="cards">
          {leaders.map((leader) => {
            const name = lang === "zh" ? leader.nameZh : leader.nameEn;
            const style = lang === "zh" ? leader.styleZh : leader.styleEn;
            const max = Math.max(...leader.curve);
            const min = Math.min(...leader.curve);
            const d = max - min || 1;
            const pts = leader.curve.map((v, i) => `${(i / (leader.curve.length - 1)) * 120},${32 - ((v - min) / d) * 28}`).join(" ");
            return (
              <article key={leader.id} className="card">
                <span className="sim-flag">{t.copyFictional}</span>
                <h3>{name}</h3>
                <p className="hint">{style}</p>
                <svg className="pnl-curve" viewBox="0 0 120 36"><polyline fill="none" stroke="#F5D58A" strokeWidth="1.4" points={pts} /></svg>
                <p>{t.copyWin} <b className="num">{Math.round(leader.winRate * 100)}%</b></p>
                <p>{t.copyDrawdown} <b className="num">{Math.round(leader.drawdown * 1000) / 10}%</b></p>
                <Button onClick={() => void follow(leader.id)}>{t.copyFollow}</Button>
              </article>
            );
          })}
        </div>
        <section className="panel">
          <h2>{t.copyFollow}</h2>
          {follows.length === 0 ? <p className="hint">{t.copyEmpty}</p> : (
            <table className="table">
              <thead><tr><th></th><th>{t.copyAlloc}</th><th>{t.copyDrawdown}</th><th>{t.status}</th></tr></thead>
              <tbody>
                {follows.map((row) => (
                  <tr key={row.leader_id}>
                    <td>{row.leader_id}</td>
                    <td className="num">{formatUsd(row.allocation_uusd)}</td>
                    <td>{(row.max_drawdown_bps / 100).toFixed(0)}%</td>
                    <td>{row.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {trades.length > 0 ? (
            <table className="table">
              <thead><tr><th>{t.time}</th><th></th><th>{t.side}</th><th>{t.last}</th></tr></thead>
              <tbody>
                {trades.map((row) => (
                  <tr key={row.id}>
                    <td>{timeLabel(row.created_at)}</td>
                    <td>{row.leader_id} · {row.symbol}</td>
                    <td>{row.side}</td>
                    <td className="num">{formatQtyWithUnit(row.symbol, row.qty, words)} · {centsToUsd(row.price_px)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </section>
      </div>
    </Shell>
  );
}
