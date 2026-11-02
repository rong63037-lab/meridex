"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { tri } from "@/lib/tri";

type Article = { id: string; title_zh: string; title_en: string; title_ms?: string | null; body_zh: string; body_en: string; body_ms?: string | null };
type Ticket = { id: string; subject: string; status: string; email: string };

export default function SupportPage() {
  const { lang } = useI18n();
  const [q, setQ] = useState("");
  const [articles, setArticles] = useState<Article[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  function load() {
    api<{ articles: Article[] }>(`/api/help?q=${encodeURIComponent(q)}`).then((res) => setArticles(res.articles)).catch(() => undefined);
    api<{ tickets: Ticket[] }>("/api/support/tickets").then((res) => setTickets(res.tickets)).catch(() => undefined);
  }
  useEffect(() => { load(); }, []);

  return (
    <Shell>
      <div className="page">
        <section className="panel">
          <div className="kicker">{tri(lang, "帮助中心", "Help centre", "Pusat bantuan")}</div>
          <h1>{tri(lang, "客户支持", "Support", "Sokongan")}</h1>
          <p className="hint">{tri(lang, "可以搜索帮助、开工单，或用右下角的坐席。坐席不会转给真人。", "Search the help centre, open a ticket, or use the chat. The agent is not a person.", "Cari bantuan, buka tiket, atau guna sembang. Ejen bukan orang sebenar.")}</p>
          <div className="chat-compose">
            <input className="desk-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tri(lang, "搜索", "Search", "Cari")} />
            <Button variant="outline" onClick={load}>{tri(lang, "搜索", "Search", "Cari")}</Button>
          </div>
          {articles.map((row) => (
            <article key={row.id}>
              <h3>{tri(lang, row.title_zh, row.title_en, row.title_ms || row.title_en)}</h3>
              <p className="hint">{tri(lang, row.body_zh, row.body_en, row.body_ms || row.body_en)}</p>
            </article>
          ))}
          <p><Link href="/help">{tri(lang, "全部帮助", "All help topics", "Semua topik bantuan")}</Link></p>
        </section>
        <section className="panel">
          <h2>{tri(lang, "工单", "Tickets", "Tiket")}</h2>
          <input className="desk-input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={tri(lang, "主题", "Subject", "Subjek")} />
          <input className="desk-input" value={body} onChange={(e) => setBody(e.target.value)} placeholder={tri(lang, "发生了什么", "What happened", "Apa yang berlaku")} />
          <Button onClick={() => api("/api/support/tickets", { method: "POST", body: JSON.stringify({ subject, body }) }).then(() => { setSubject(""); setBody(""); load(); })}>{tri(lang, "提交", "Open", "Hantar")}</Button>
          {tickets.map((row) => <p key={row.id} className="hint">{row.subject} · {row.status}</p>)}
        </section>
      </div>
    </Shell>
  );
}
