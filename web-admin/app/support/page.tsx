"use client";

import { useEffect, useState } from "react";
import { Shell } from "@/components/Shell";
import { api } from "@/lib/api";
import { conciergeCopy } from "@/lib/concierge-copy";
import { tri } from "@/lib/tri";
import { useI18n } from "@/lib/i18n";

type Thread = { user_id: number; email: string; n: number };
type Ticket = { id: string; subject: string; status: string; email: string };
type Msg = { id: number; body: string; masked?: string; staff: boolean; kind?: string; card?: { verified?: boolean; issuer?: string; asset?: string; network?: string; address?: string; status?: string; amount?: string; depositId?: string } | null };
type Queue = {
  depositChats: { user_id: number; email: string; n: number }[];
  callbacks: { id: string; email: string; callback_at: string; callback_lang: string; status: string }[];
  tasks: { id: string; email: string; title: string; status: string }[];
};
type Hit = { id: string; email: string; user_id: number; asset: string; network: string | null; amount: string; status: string; txid: string | null };

const PAIRS = [
  { asset: "USDT", network: "TRC20", label: "USDT-TRC20" },
  { asset: "USDT", network: "ERC20", label: "USDT-ERC20" },
  { asset: "BTC", network: "Bitcoin", label: "BTC" },
  { asset: "ETH", network: "Ethereum", label: "ETH" },
];

export default function SupportDesk() {
  const { lang } = useI18n();
  const copy = conciergeCopy(lang);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [queues, setQueues] = useState<Queue | null>(null);
  const [userId, setUserId] = useState<number | null>(null);
  const [email, setEmail] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [showFull, setShowFull] = useState(false);
  const [pair, setPair] = useState(PAIRS[0].label);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [customer, setCustomer] = useState("");
  const [manager, setManager] = useState("");
  const [vip, setVip] = useState(true);
  const [error, setError] = useState("");

  function loadLists() {
    api<{ threads: Thread[]; tickets: Ticket[] }>("/api/admin/support/inbox")
      .then((res) => { setThreads(res.threads); setTickets(res.tickets); })
      .catch((err) => setError((err as Error).message));
    api<Queue>("/api/admin/support/queues").then(setQueues).catch(() => undefined);
  }
  useEffect(() => {
    loadLists();
    const search = new URLSearchParams(window.location.search);
    const id = Number(search.get("user"));
    if (Number.isInteger(id) && id > 0) void openThread(id, search.get("email") ?? "");
  }, []);

  async function openThread(id: number, who: string) {
    setUserId(id);
    setEmail(who);
    setError("");
    const res = await api<{ messages: Msg[] }>(`/api/admin/support/chat?userId=${id}`);
    setMessages(res.messages);
  }

  async function reply() {
    if (!userId || !text.trim()) return;
    setError("");
    try {
      const res = await api<{ messages: Msg[] }>("/api/admin/support/chat", {
        method: "POST",
        body: JSON.stringify({ userId, body: text.trim() }),
      });
      setMessages(res.messages);
      setText("");
    } catch (err) {
      setError(copy.warning + " " + (err as Error).message);
    }
  }

  async function sendCard() {
    if (!userId) return;
    const chosen = PAIRS.find((item) => item.label === pair) ?? PAIRS[0];
    setError("");
    try {
      const res = await api<{ messages: Msg[] }>("/api/admin/support/deposit-card", {
        method: "POST",
        body: JSON.stringify({ userId, asset: chosen.asset, network: chosen.network }),
      });
      setMessages(res.messages);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function search() {
    setError("");
    try {
      const res = await api<{ deposits: Hit[] }>(`/api/admin/support/deposits?q=${encodeURIComponent(query)}`);
      setHits(res.deposits);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function paste(hit: Hit) {
    setError("");
    try {
      const res = await api<{ messages: Msg[] }>("/api/admin/support/deposit-status-card", {
        method: "POST",
        body: JSON.stringify({ userId: hit.user_id, depositId: hit.id }),
      });
      setUserId(hit.user_id);
      setEmail(hit.email);
      setMessages(res.messages);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Shell>
      <div className="page">
        <section className="panel">
          <div className="kicker">{copy.depositQueue}</div>
          <h1>{tri(lang, "坐席台", "Agent console", "Konsol ejen")}</h1>
          <p className="scam">{copy.banner}</p>
          {error ? <p className="err">{error}</p> : null}
        </section>
        <section className="split">
          <div className="panel">
            <h2>{copy.depositQueue}</h2>
            {(queues?.depositChats ?? []).length === 0 ? <p className="hint">{copy.empty}</p> : queues?.depositChats.map((row) => (
              <p key={row.user_id}><button type="button" className="langbtn" onClick={() => void openThread(row.user_id, row.email)}>{row.email} · {row.n}</button></p>
            ))}
            <h2>{copy.callbackQueue}</h2>
            {(queues?.callbacks ?? []).map((row) => <p key={row.id} className="hint">{row.email} · {row.callback_lang} · {row.callback_at}</p>)}
            <h2>{copy.tasks}</h2>
            {(queues?.tasks ?? []).map((row) => <p key={row.id} className="hint">{row.email} · {row.title}</p>)}
            <h2>{tri(lang, "全部会话", "All chats", "Semua sembang")}</h2>
            {threads.map((row) => (
              <p key={row.user_id}><button type="button" className="langbtn" onClick={() => void openThread(row.user_id, row.email)}>{row.email} · {row.n}</button></p>
            ))}
          </div>
          <div className="panel">
            <h2>{email || copy.reply}</h2>
            <button type="button" className="langbtn" onClick={() => setShowFull((v) => !v)}>{showFull ? copy.hide : copy.show}</button>
            <div className="chat-log">
              {messages.map((row) => row.kind === "deposit_card" && row.card?.verified && row.card.issuer === "MERIDEX" ? (
                <article key={row.id} className="verified-card">
                  <span className="badge">Verified by MERIDEX</span>
                  <b>{row.card.asset} · {row.card.network}</b>
                  <p className="num addr">{row.card.address}</p>
                </article>
              ) : row.kind === "deposit_status" && row.card?.verified ? (
                <article key={row.id} className="verified-card">
                  <span className="badge">Verified by MERIDEX</span>
                  <p>{row.card.asset} · {row.card.status} · {row.card.amount}</p>
                </article>
              ) : (
                <p key={row.id} className={row.staff ? "staff" : ""}>{showFull ? row.body : row.masked || row.body}</p>
              ))}
            </div>
            <div className="chat-compose">
              <input className="desk-input" value={text} onChange={(e) => setText(e.target.value)} />
              <button type="button" onClick={() => void reply()}>{copy.reply}</button>
            </div>
            <div className="chat-compose">
              <select className="desk-input" value={pair} onChange={(e) => setPair(e.target.value)}>
                {PAIRS.map((item) => <option key={item.label}>{item.label}</option>)}
              </select>
              <button type="button" onClick={() => void sendCard()}>{copy.card}</button>
            </div>
            <button type="button" className="langbtn" onClick={() => { setText("/funds/deposit"); }}>{copy.guide}</button>
          </div>
        </section>
        <section className="panel">
          <h2>{copy.lookup}</h2>
          <div className="chat-compose">
            <input className="desk-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="txid / address / reference / email" />
            <button type="button" onClick={() => void search()}>{copy.lookup}</button>
          </div>
          {hits.map((hit) => (
            <p key={hit.id} className="hint">{hit.email} · {hit.asset} {hit.network} · {hit.amount} · {hit.status} · <button type="button" className="langbtn" onClick={() => void paste(hit)}>{copy.card}</button></p>
          ))}
        </section>
        <section className="panel">
          <h2>{copy.assign}</h2>
          <label>{copy.customer}</label>
          <input className="desk-input" value={customer} onChange={(e) => setCustomer(e.target.value)} />
          <label>{copy.manager}</label>
          <input className="desk-input" value={manager} onChange={(e) => setManager(e.target.value)} />
          <label><input type="checkbox" checked={vip} onChange={(e) => setVip(e.target.checked)} /> {copy.vip}</label>
          <div style={{ marginTop: 8 }}>
            <button type="button" className="langbtn" onClick={() => void api("/api/admin/support/manager", { method: "POST", body: JSON.stringify({ customerEmail: customer, managerEmail: manager, vip }) }).then(() => setError("")).catch((err) => setError((err as Error).message))}>{copy.save}</button>
          </div>
        </section>
        <section className="panel">
          <h2>{tri(lang, "工单", "Tickets", "Tiket")}</h2>
          {tickets.length === 0 ? <p className="hint">{copy.empty}</p> : tickets.map((row) => (
            <p key={row.id} className="hint">{row.email} · {row.subject} · {row.status}</p>
          ))}
        </section>
      </div>
    </Shell>
  );
}
