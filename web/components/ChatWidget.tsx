"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { conciergeCopy } from "@/lib/concierge-copy";
import { useI18n } from "@/lib/i18n";

type Card = {
  verified?: boolean;
  issuer?: string;
  kind?: string;
  asset?: string;
  network?: string;
  address?: string;
  memo?: string | null;
  min?: string;
  qrDataUrl?: string;
  warning?: string;
  hint?: string;
  guidePath?: string;
  depositId?: string;
  status?: string;
  amount?: string;
  txid?: string;
};
type Msg = { id: number; body: string; staff: boolean; kind?: string; card?: Card | null; author_email?: string };

export function ChatWidget() {
  const { lang } = useI18n();
  const copy = conciergeCopy(lang);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [topic, setTopic] = useState<string | null>(null);
  const [rows, setRows] = useState<Msg[]>([]);
  const [ready, setReady] = useState(false);
  const [copied, setCopied] = useState("");
  const [manager, setManager] = useState("");
  const [when, setWhen] = useState("");
  const [phone, setPhone] = useState("");
  const [language, setLanguage] = useState(lang === "en" ? "en" : lang === "ms" ? "ms" : "zh");
  const [booked, setBooked] = useState("");

  function load() {
    if (!localStorage.getItem("meridex.token")) return;
    api<{ messages: Msg[] }>("/api/support/chat").then((res) => setRows(res.messages)).catch(() => undefined);
  }

  useEffect(() => {
    setReady(Boolean(localStorage.getItem("meridex.token")));
    load();
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ topic?: string; prefill?: string }>).detail ?? {};
      setOpen(true);
      if (detail.topic) setTopic(detail.topic);
      if (detail.prefill) setText(detail.prefill);
      load();
      api<{ manager: { email: string } | null }>("/api/wallet/deposit-instructions")
        .then((res) => setManager(res.manager?.email ?? ""))
        .catch(() => undefined);
    };
    window.addEventListener("meridex-open-chat", onOpen);
    return () => window.removeEventListener("meridex-open-chat", onOpen);
  }, []);

  if (!ready) return null;

  async function send() {
    const body = text.trim();
    if (!body) return;
    setText("");
    const res = await api<{ messages: Msg[] }>("/api/support/chat", {
      method: "POST",
      body: JSON.stringify({ body, topic: topic === "deposit" ? "deposit" : undefined }),
    });
    setRows(res.messages);
  }

  return (
    <div className="chat-widget">
      {open ? (
        <div className="panel chat-panel">
          <p className="scam">{copy.banner}</p>
          <div className="kicker">{topic === "deposit" ? copy.title : copy.open}</div>
          {manager ? <p className="hint">{copy.manager} · {manager}</p> : null}
          <a className="langbtn" href="/funds/deposit">{copy.goDeposit}</a>
          <div className="chat-log">
            {rows.map((row) => {
              const card = row.card;
              const verified = (row.kind === "deposit_card" || row.kind === "deposit_status") && card?.verified === true && card.issuer === "MERIDEX";
              if (verified && row.kind === "deposit_card") {
                return (
                  <article key={row.id} className="verified-card">
                    <span className="badge">{copy.verified}</span>
                    <b>{card.asset} · {card.network}</b>
                    {card.qrDataUrl ? <img src={card.qrDataUrl} alt="" width={140} height={140} /> : null}
                    <p className="num addr">{card.address}</p>
                    <p className="hint">{card.memo || copy.noMemo} · min {card.min}</p>
                    <p className="hint">{card.hint || copy.hint}</p>
                    <p className="hint">{card.warning || copy.wrongNet}</p>
                    <button type="button" className="langbtn" onClick={() => { void navigator.clipboard.writeText(card.address ?? ""); setCopied(card.address ?? ""); }}>{copied === card.address ? copy.copied : copy.copy}</button>
                    <a className="langbtn" href={card.guidePath || "/funds/deposit"}>{copy.goDeposit}</a>
                  </article>
                );
              }
              if (verified && row.kind === "deposit_status") {
                return (
                  <article key={row.id} className="verified-card">
                    <span className="badge">{copy.verified}</span>
                    <b>{card.asset} · {card.status}</b>
                    <p className="hint">{card.amount} · {card.network} · {card.depositId}</p>
                    {card.txid ? <p className="num">{card.txid}</p> : null}
                  </article>
                );
              }
              return <p key={row.id} className={row.staff ? "staff" : ""}>{row.body}</p>;
            })}
          </div>
          <details className="chat-extra">
            <summary>{copy.callback}</summary>
            <label>{copy.when}</label>
            <input className="desk-input" value={when} onChange={(e) => setWhen(e.target.value)} placeholder="2026-10-20 15:00" />
            <label>{copy.language}</label>
            <select className="desk-input" value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="zh">中文</option>
              <option value="en">English</option>
              <option value="ms">Bahasa Melayu</option>
            </select>
            <label>{copy.phone}</label>
            <input className="desk-input" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <button type="button" className="langbtn" onClick={() => {
              void api("/api/support/callbacks", { method: "POST", body: JSON.stringify({ when, language, phone }) })
                .then(() => { setBooked(copy.booked); setWhen(""); })
                .catch((err) => setBooked((err as Error).message));
            }}>{copy.book}</button>
            {booked ? <p className="hint">{booked}</p> : null}
          </details>
          <div className="chat-compose">
            <input className="desk-input" value={text} onChange={(e) => setText(e.target.value)} />
            <button type="button" onClick={() => void send()}>{copy.send}</button>
          </div>
        </div>
      ) : null}
      <button type="button" className="chat-launch" onClick={() => { setOpen((v) => !v); load(); }}>{copy.title}</button>
    </div>
  );
}
