"use client";

import { useEffect, useState } from "react";
import { Shell } from "@/components/Shell";
import { api } from "@/lib/api";
import { timeLabel } from "@/lib/format";
import { tri } from "@/lib/tri";
import { useI18n } from "@/lib/i18n";

type Row = { id: number; email: string; channel: string; title: string; body: string; provider: string; status: string; created_at: string };

export default function OutboxPage() {
  const { lang } = useI18n();
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ messages: Row[] }>("/api/admin/notifications").then((res) => setRows(res.messages)).catch((err) => setError((err as Error).message));
  }, []);
  return (
    <Shell>
      <div className="page">
        <section className="panel">
          <div className="kicker">{tri(lang, "模拟通道", "Mock providers", "Penyedia simulasi")}</div>
          <h1>{tri(lang, "通知发件箱", "Notification outbox", "Peti keluar pemberitahuan")}</h1>
          <p className="hint">{tri(lang, "不会真正发出。状态一直是 mock_sent。", "Nothing is delivered. Rows stay mock_sent.", "Tiada yang dihantar. Status kekal mock_sent.")}</p>
          {error ? <p className="err">{error}</p> : null}
          <table className="table">
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{timeLabel(row.created_at)}</td>
                  <td>{row.channel}</td>
                  <td>{row.email}</td>
                  <td>{row.title}</td>
                  <td className="hint">{row.body}</td>
                  <td>{row.provider} · {row.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </Shell>
  );
}
