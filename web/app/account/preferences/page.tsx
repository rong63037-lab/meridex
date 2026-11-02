"use client";

import { useEffect, useState } from "react";
import { AccountBack } from "@/components/AccountBack";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { accountCopy } from "@/lib/account-copy";
import { LangSelect, useI18n } from "@/lib/i18n";

type Prefs = { fills: boolean; rejects: boolean; announcements: boolean };
type Notice = { id: string; symbol: string; direction: "above" | "below"; price: string; read: boolean };

export default function PreferencesPage() {
  const { t, lang } = useI18n();
  const copy = accountCopy(lang);
  const [prefs, setPrefs] = useState<Prefs>({ fills: true, rejects: true, announcements: true });
  const [notices, setNotices] = useState<Notice[]>([]);
  const [currency, setCurrency] = useState("USD");
  const [saved, setSaved] = useState("");

  useEffect(() => {
    setCurrency(localStorage.getItem("meridex.currency") || "USD");
    api<Prefs>("/api/account/notifications").then(setPrefs).catch(() => undefined);
    api<{ notices: Notice[] }>("/api/notices").then((res) => setNotices(res.notices)).catch(() => undefined);
  }, []);

  const labels = {
    fills: lang === "zh" ? "成交提醒" : lang === "ms" ? "Amaran isian" : "Fill alerts",
    rejects: lang === "zh" ? "拒绝提醒" : lang === "ms" ? "Amaran tolakan" : "Reject alerts",
    announcements: lang === "zh" ? "公告" : lang === "ms" ? "Pengumuman" : "Announcements",
  } as const;

  return (
    <Shell>
      <div className="page">
        <AccountBack />
        <h1>{copy.prefs}</h1>
        <section className="panel">
          <label>{copy.language}</label>
          <LangSelect />
          <label>{copy.currency}</label>
          <select className="desk-input" value={currency} onChange={(e) => { setCurrency(e.target.value); localStorage.setItem("meridex.currency", e.target.value); }}>
            <option value="USD">USD</option>
          </select>
        </section>
        <form className="panel" onSubmit={(e) => { e.preventDefault(); api("/api/account/notifications", { method: "POST", body: JSON.stringify(prefs) }).then(() => setSaved("OK")); }}>
          <h2>{t.notifications}</h2>
          {(Object.keys(labels) as (keyof typeof labels)[]).map((key) => (
            <label key={key} className="check-row">
              <input type="checkbox" checked={prefs[key]} onChange={(e) => setPrefs({ ...prefs, [key]: e.target.checked })} />
              {labels[key]}
            </label>
          ))}
          <Button type="submit">{t.saveKyc}</Button>
          {saved ? <p className="hint">{saved}</p> : null}
        </form>
        <section className="panel">
          <h2>{t.noticeCentre}</h2>
          {notices.length === 0 ? <p className="hint">{t.noNotices}</p> : notices.map((notice) => (
            <p key={notice.id} className="hint">{t.priceAlert} · {notice.symbol} · {notice.direction === "above" ? t.alertAbove : t.alertBelow} {notice.price} · {notice.read ? t.markRead : t.alertFired}</p>
          ))}
          <Button type="button" variant="outline" onClick={() => api("/api/notices/read", { method: "POST" }).then(() => setNotices((rows) => rows.map((row) => ({ ...row, read: true }))))}>{t.markRead}</Button>
        </section>
      </div>
    </Shell>
  );
}
