"use client";

import { useEffect, useState } from "react";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { timeLabel } from "@/lib/format";
import { tri } from "@/lib/tri";
import { useI18n } from "@/lib/i18n";

type Alert = { id: string; rule_id: string; email: string | null; severity: string; demo: boolean; detail: string; created_at: string; symbol: string | null };
type Score = { email: string; score: number; kycTier: string; kycStatus: string | null; geoMismatch: number; openAlerts: number; jurisdiction: string | null };
type CaseRow = { id: string; title: string; status: string; subject_email: string | null };
type Note = { id: number; kind: string; body: string; actor_email: string | null; created_at: string };
type Dash = {
  rules: { id: string; title_zh: string; title_en: string; threshold: number; enabled: boolean; window_sec: number }[];
  alerts: Alert[];
  byRule: { rule_id: string; n: number }[];
  series: { t: string; n: number }[];
  cases: CaseRow[];
  scores: Score[];
};

export default function RiskPage() {
  const { lang } = useI18n();
  const [dash, setDash] = useState<Dash | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [caseId, setCaseId] = useState("case-wash");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  function load() {
    api<Dash>("/api/admin/risk/dashboard").then(setDash).catch((err) => setError((err as Error).message));
  }
  function loadCase(id: string) {
    setCaseId(id);
    api<{ notes: Note[] }>(`/api/admin/risk/cases/${id}`).then((res) => setNotes(res.notes)).catch(() => setNotes([]));
  }
  useEffect(() => { load(); loadCase("case-wash"); }, []);

  const max = Math.max(1, ...(dash?.byRule.map((row) => row.n) ?? [1]));
  const selected = dash?.cases.find((row) => row.id === caseId);

  return (
    <Shell>
      <div className="page">
        <section className="panel">
          <div className="kicker">{tri(lang, "合规 · 风险巡检", "Compliance · risk", "Pematuhan · risiko")}</div>
          <h1>{tri(lang, "巡检台", "Surveillance", "Pengawasan")}</h1>
          <p className="hint">{tri(lang,
            "对倒、幌骗、偏离参考价、异常量、大额委托、大额出金和下单速度。标成机器人的行不是客户。",
            "Wash trades, spoofing, reference-price gaps, volume, large orders, large withdrawals, and velocity. Rows marked bot are produced by bots.",
            "Padanan sendiri, spoofing, jurang harga rujukan, volum, pesanan besar, pengeluaran besar, dan kelajuan. Baris bot datang daripada bot.",
          )}</p>
          <span className="sim-flag">{tri(lang, "机器人告警", "Bot alerts", "Amaran bot")}</span>
          {error ? <p className="err">{error}</p> : null}
        </section>
        <section className="panel">
          <h2>{tri(lang, "按规则", "Alerts by rule", "Amaran mengikut peraturan")}</h2>
          <div className="bars">
            {(dash?.byRule ?? []).map((row) => (
              <div key={row.rule_id}>
                <span>{row.rule_id}</span>
                <i style={{ width: `${(row.n / max) * 100}%` }} />
                <b className="num">{row.n}</b>
              </div>
            ))}
          </div>
          <p className="hint">{(dash?.series ?? []).map((row) => `${row.t} ${row.n}`).join(" · ") || "—"}</p>
        </section>
        <section className="split">
          <div className="panel">
            <h2>{tri(lang, "阈值", "Rules", "Peraturan")}</h2>
            <table className="table">
              <tbody>
                {(dash?.rules ?? []).map((rule) => (
                  <tr key={rule.id}>
                    <td>{tri(lang, rule.title_zh, rule.title_en, rule.title_en)}</td>
                    <td className="num">{rule.threshold}</td>
                    <td>{rule.enabled ? "on" : "off"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <h2>{tri(lang, "客户风险分", "Risk scores", "Skor risiko")}</h2>
            <table className="table">
              <thead><tr><th></th><th>KYC</th><th>Geo</th><th></th></tr></thead>
              <tbody>
                {(dash?.scores ?? []).map((row) => (
                  <tr key={row.email}>
                    <td>{row.email}<div className="hint">{row.jurisdiction}</div></td>
                    <td>{row.kycTier} · {row.kycStatus}</td>
                    <td className="num">{row.geoMismatch}</td>
                    <td className="num">{row.score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="panel">
          <h2>{tri(lang, "告警", "Live tape", "Pita langsung")}</h2>
          <table className="table">
            <tbody>
              {(dash?.alerts ?? []).map((row) => (
                <tr key={row.id}>
                  <td>{timeLabel(row.created_at)}</td>
                  <td>{row.rule_id}</td>
                  <td>{row.demo ? tri(lang, "机器人", "bot", "bot") : row.email}</td>
                  <td className={row.severity === "high" ? "down" : ""}>{row.severity}</td>
                  <td>{row.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="panel" id="case-view">
          <h2>{tri(lang, "案件", "Case", "Kes")}</h2>
          <div className="tf">
            {(dash?.cases ?? []).map((row) => (
              <button key={row.id} type="button" className={row.id === caseId ? "on" : ""} onClick={() => loadCase(row.id)}>{row.title}</button>
            ))}
          </div>
          {selected ? <p className="hint">{selected.status} · {selected.subject_email}</p> : null}
          <ul className="case-notes">
            {notes.map((row) => (
              <li key={row.id}><b>{row.kind}</b> {row.body}<span>{row.actor_email} · {timeLabel(row.created_at)}</span></li>
            ))}
          </ul>
          <div className="chat-compose">
            <input className="desk-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={tri(lang, "备注", "Note", "Nota")} />
            <Button onClick={() => api(`/api/admin/risk/cases/${caseId}`, { method: "POST", body: JSON.stringify({ action: "note", body: note }) }).then(() => { setNote(""); loadCase(caseId); })}>{tri(lang, "记下", "Add note", "Tambah nota")}</Button>
            <Button variant="outline" onClick={() => api(`/api/admin/risk/cases/${caseId}`, { method: "POST", body: JSON.stringify({ action: "assign", body: "接手" }) }).then(() => loadCase(caseId))}>{tri(lang, "分给我", "Assign me", "Ambil kes")}</Button>
          </div>
        </section>
      </div>
    </Shell>
  );
}
