"use client";

import { useEffect, useState } from "react";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { timeLabel } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { tri } from "@/lib/tri";

type Msg = { id: string; channel: string; title: string; body: string; provider: string | null; status: string; phishing_code: string | null; created_at: string };
type Prefs = { email_on: boolean; sms_on: boolean; push_on: boolean };

export default function InboxPage() {
  const { lang } = useI18n();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [prefs, setPrefs] = useState<Prefs>({ email_on: true, sms_on: false, push_on: true });

  function load() {
    api<{ messages: Msg[]; prefs: Prefs }>("/api/notifications").then((res) => {
      setMessages(res.messages);
      setPrefs(res.prefs);
    }).catch(() => undefined);
  }
  useEffect(() => { load(); }, []);

  function save(next: Prefs) {
    setPrefs(next);
    void api("/api/notifications/prefs", {
      method: "POST",
      body: JSON.stringify({ emailOn: next.email_on, smsOn: next.sms_on, pushOn: next.push_on }),
    });
  }

  return (
    <Shell>
      <div className="page">
        <section className="panel">
          <div className="kicker">{tri(lang, "本地模拟通道", "Mock providers", "Saluran simulasi tempatan")}</div>
          <h1>{tri(lang, "通知中心", "Notifications", "Pemberitahuan")}</h1>
          <p className="hint">{tri(
            lang,
            "邮件、短信和推送都停在发件箱里，由 mock-email / mock-sms / mock-push 签收，不会真正发出。",
            "Email, SMS, and push stay in the outbox. Nothing is sent to a carrier.",
            "E-mel, SMS dan tolakan kekal dalam peti keluar. Tiada yang dihantar kepada pembawa.",
          )}</p>
          <div className="tf">
            <button type="button" className={prefs.email_on ? "on" : ""} onClick={() => save({ ...prefs, email_on: !prefs.email_on })}>Email</button>
            <button type="button" className={prefs.sms_on ? "on" : ""} onClick={() => save({ ...prefs, sms_on: !prefs.sms_on })}>SMS</button>
            <button type="button" className={prefs.push_on ? "on" : ""} onClick={() => save({ ...prefs, push_on: !prefs.push_on })}>Push</button>
          </div>
        </section>
        <section className="panel">
          {messages.length === 0 ? <p className="hint">{tri(lang, "还没有通知。安全操作会写一封带防钓鱼码的邮件。", "Nothing queued.", "Tiada dalam baris gilir. Tindakan keselamatan menulis e-mel dengan kod anti-pancingan.")}</p> : null}
          {messages.map((row) => (
            <article key={row.id} className="card">
              <div className="kicker">{row.channel} · {row.provider} · {row.status}</div>
              <h3>{row.title}</h3>
              <p className="hint">{row.body}</p>
              <p className="hint">{timeLabel(row.created_at)}{row.phishing_code ? ` · ${row.phishing_code}` : ""}</p>
            </article>
          ))}
          <Button variant="outline" onClick={load}>{tri(lang, "刷新", "Refresh", "Segar semula")}</Button>
        </section>
      </div>
    </Shell>
  );
}
