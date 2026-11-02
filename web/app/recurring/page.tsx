"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { EmptyMark } from "@/components/EmptyMark";
import { api } from "@/lib/api";
import { centsToUsd, formatUsd, timeLabel } from "@/lib/format";
import { useI18n, reasonText } from "@/lib/i18n";
import { usePaperMode } from "@/lib/usePaper";

type Plan = {
  id: string;
  symbol: string;
  amountUusd: string;
  cadence: string;
  status: string;
  namespace: string;
  nextRunAt: string;
  averageCost: string | null;
};
type Run = { id: string; symbol: string; status: string; qty: string | null; price_px: string | null; created_at: string; namespace: string };

const CADENCE = ["daily", "weekly", "monthly"] as const;

export default function RecurringPage() {
  const { t, lang } = useI18n();
  const { paper } = usePaperMode();
  const [symbol, setSymbol] = useState("XAU/USD");
  const [symbols, setSymbols] = useState<string[]>(["XAU/USD"]);
  const [amount, setAmount] = useState("25.00");
  const [cadence, setCadence] = useState<(typeof CADENCE)[number]>("daily");
  const [plans, setPlans] = useState<Plan[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [clock, setClock] = useState(1);
  const [error, setError] = useState("");

  const label = { daily: t.recurringDaily, weekly: t.recurringWeekly, monthly: t.recurringMonthly };

  function load() {
    api<{ plans: Plan[]; runs: Run[]; clock: number }>("/api/recurring")
      .then((res) => {
        setPlans(res.plans);
        setRuns(res.runs);
        setClock(res.clock);
      })
      .catch((err) => setError(reasonText(lang, (err as Error).message)));
  }

  useEffect(() => {
    api<{ instruments: { symbol: string; status: string }[] }>("/api/market/instruments")
      .then((res) => {
        const names = res.instruments.filter((row) => row.status === "trading").map((row) => row.symbol);
        if (names.length) setSymbols(names);
      })
      .catch(() => undefined);
    load();
  }, []);

  async function start(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await api("/api/recurring", { method: "POST", body: JSON.stringify({ symbol, amount, cadence, paper }) });
      load();
    } catch (err) {
      setError(reasonText(lang, (err as Error).message));
    }
  }

  async function act(id: string, action: "pause" | "resume" | "cancel" | "run") {
    setError("");
    try {
      if (action === "run") await api(`/api/recurring/${id}/run`, { method: "POST", body: "{}" });
      else await api(`/api/recurring/${id}`, { method: "POST", body: JSON.stringify({ action }) });
      load();
    } catch (err) {
      setError(reasonText(lang, (err as Error).message));
    }
  }

  return (
    <Shell>
      <div className="page">
        <section className="panel">
          <div className="kicker">{paper ? t.paperMode : t.modeReal}</div>
          <h1>{t.recurringTitle}</h1>
          <p className="hint">{t.recurringBody}</p>
        </section>
        <form className="panel" onSubmit={start}>
          <div className="split">
            <div>
              <label>{t.symbol}</label>
              <select className="desk-input" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
                {symbols.map((name) => <option key={name}>{name}</option>)}
              </select>
            </div>
            <div>
              <label>{t.recurringAmount}</label>
              <input className="desk-input" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
          </div>
          <div className="tf" style={{ marginTop: 12 }}>
            {CADENCE.map((item) => (
              <button key={item} type="button" className={cadence === item ? "on" : ""} onClick={() => setCadence(item)}>{label[item]}</button>
            ))}
          </div>
          {error ? <p className="err">{error}</p> : null}
          <Button type="submit">{t.recurringStart}</Button>
        </form>
        <section className="panel">
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <h2>{t.recurringClock} · {clock}×</h2>
            <div className="tf">
              {[1, 60, 1440].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={clock === n ? "on" : ""}
                  onClick={() => api("/api/recurring/clock", { method: "POST", body: JSON.stringify({ multiplier: n }) }).then(load)}
                >
                  {n}×
                </button>
              ))}
            </div>
          </div>
          <p className="hint">{t.recurringClockHint}</p>
          {plans.length === 0 ? <div className="empty-chart"><EmptyMark /><p>{t.recurringEmpty}</p></div> : (
            <table className="table">
              <thead><tr><th></th><th>{t.recurringAmount}</th><th>{t.recurringNext}</th><th>{t.recurringAvg}</th><th></th></tr></thead>
              <tbody>
                {plans.map((plan) => (
                  <tr key={plan.id}>
                    <td>{plan.symbol}<div className="hint">{label[plan.cadence as keyof typeof label] ?? plan.cadence} · {plan.status} · {plan.namespace === "paper" ? t.paperNamespace : t.realNamespace}</div></td>
                    <td className="num">{formatUsd(plan.amountUusd)}</td>
                    <td>{plan.status === "canceled" ? "—" : timeLabel(plan.nextRunAt)}</td>
                    <td className="num">{plan.averageCost ? centsToUsd(plan.averageCost) : "—"}</td>
                    <td className="tf">
                      {plan.status !== "canceled" ? <button type="button" onClick={() => void act(plan.id, "run")}>{t.recurringRun}</button> : null}
                      {plan.status === "active" ? <button type="button" onClick={() => void act(plan.id, "pause")}>{t.recurringPause}</button> : null}
                      {plan.status === "paused" ? <button type="button" onClick={() => void act(plan.id, "resume")}>{t.recurringResume}</button> : null}
                      {plan.status !== "canceled" ? <button type="button" onClick={() => void act(plan.id, "cancel")}>{t.recurringCancel}</button> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {runs.length > 0 ? (
            <table className="table">
              <thead><tr><th>{t.time}</th><th></th><th>{t.status}</th><th>{t.last}</th></tr></thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td>{timeLabel(run.created_at)}</td>
                    <td>{run.symbol}</td>
                    <td>{run.status}</td>
                    <td className="num">{run.price_px ? centsToUsd(run.price_px) : "—"}</td>
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
