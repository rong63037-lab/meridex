"use client";

import { useEffect, useState } from "react";
import { AccountBack } from "@/components/AccountBack";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { timeLabel } from "@/lib/format";
import { useI18n } from "@/lib/i18n";

type Session = { id: string; ip: string | null; country: string | null; revoked: boolean; created_at: string; last_seen: string; device_label?: string };
type Login = { id: number; ip: string | null; country: string | null; created_at: string };

function line(lang: string, en: string, zh: string, ms: string) {
  if (lang === "en") return en;
  if (lang === "ms") return ms;
  return zh;
}

export default function SecurityPage() {
  const { t, lang } = useI18n();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [logins, setLogins] = useState<Login[]>([]);
  const [stepUp, setStepUp] = useState("");
  const [phish, setPhish] = useState("");
  const [address, setAddress] = useState("");
  const [nextPw, setNextPw] = useState("");
  const [currentPw, setCurrentPw] = useState("");
  const [frozen, setFrozen] = useState(false);
  const [addresses, setAddresses] = useState<{ id: string; asset: string; address: string; status: string; unlock_at: string }[]>([]);
  const [note, setNote] = useState("");

  function load() {
    api<Session[]>("/api/account/sessions").then(setSessions).catch(() => undefined);
    api<Login[]>("/api/account/logins").then(setLogins).catch(() => undefined);
    api<{ profile: { frozen: boolean; phishing_code: string | null }; addresses: { id: string; asset: string; address: string; status: string; unlock_at: string }[] }>("/api/account/security")
      .then((res) => { setFrozen(Boolean(res.profile?.frozen)); setPhish(res.profile?.phishing_code ?? ""); setAddresses(res.addresses ?? []); })
      .catch(() => undefined);
  }
  useEffect(() => { load(); }, []);

  return (
    <Shell>
      <div className="page">
        <AccountBack />
        <h1>{t.security}</h1>
        <div className="panel">
          <h2>{t.totp}</h2>
          <p className="hint">{t.mfaNote}</p>
        </div>
        <div className="split">
          <div className="panel">
            <h2>{t.security}</h2>
            {sessions.map((session) => (
              <p key={session.id} className="hint">
                {session.country ?? "—"} · {session.ip} · {timeLabel(session.created_at)} · {session.revoked ? t.rejected : t.open}
                {!session.revoked ? <Button size="sm" variant="ghost" onClick={() => api(`/api/account/sessions/${session.id}/revoke`, { method: "POST" }).then(load)}>{t.cancel}</Button> : null}
                <span className="hint">{session.device_label}</span>
              </p>
            ))}
          </div>
          <div className="panel">
            <h2>{t.login}</h2>
            {logins.map((row) => <p key={row.id} className="hint">{timeLabel(row.created_at)} · {row.country} · {row.ip}</p>)}
          </div>
        </div>
        <div className="panel">
          <h2>{line(lang, "Step-up and lock", "二次验证与锁定", "Pengesahan dan kunci")}</h2>
          <p className="hint">{note}</p>
          <label>{t.totp}</label>
          <input className="desk-input" value={stepUp} onChange={(e) => setStepUp(e.target.value)} />
          <label>{line(lang, "Anti-phishing code", "防钓鱼码", "Kod anti-pancingan")}</label>
          <div className="chat-compose">
            <input className="desk-input" value={phish} onChange={(e) => setPhish(e.target.value)} />
            <Button onClick={() => api("/api/account/phishing", { method: "POST", body: JSON.stringify({ code: phish, stepUp }) }).then(load).catch((err) => setNote((err as Error).message))}>{t.create}</Button>
          </div>
          <label>{line(lang, "Withdrawal address", "出金地址", "Alamat pengeluaran")}</label>
          <div className="chat-compose">
            <input className="desk-input" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="bc1..." />
            <Button variant="outline" onClick={() => api("/api/account/whitelist", { method: "POST", body: JSON.stringify({ asset: "BTC", address, label: "desk", stepUp }) }).then(load).catch((err) => setNote((err as Error).message))}>{line(lang, "Lock 24h", "锁定 24 小时", "Kunci 24 jam")}</Button>
          </div>
          {addresses.map((row) => <p key={row.id} className="hint">{row.asset} · {row.address} · {row.status} · {timeLabel(row.unlock_at)}</p>)}
          <label>{t.password}</label>
          <input className="desk-input" type="password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} placeholder={line(lang, "Current", "当前密码", "Semasa")} />
          <input className="desk-input" type="password" value={nextPw} onChange={(e) => setNextPw(e.target.value)} placeholder={line(lang, "New", "新密码", "Baharu")} />
          <div className="tf" style={{ marginTop: 8 }}>
            <Button variant="outline" onClick={() => api("/api/account/password", { method: "POST", body: JSON.stringify({ current: currentPw, next: nextPw, stepUp }) }).then(() => setNote("ok")).catch((err) => setNote((err as Error).message))}>{line(lang, "Change password", "改密码", "Tukar kata laluan")}</Button>
            <Button variant="outline" onClick={() => api("/api/account/freeze", { method: "POST", body: JSON.stringify({ frozen: !frozen, reason: frozen ? "unfreeze" : "self freeze", stepUp }) }).then(load).catch((err) => setNote((err as Error).message))}>{frozen ? line(lang, "Unfreeze", "解冻", "Nyahbeku") : line(lang, "Freeze account", "冻结账户", "Bekukan akaun")}</Button>
            <Button variant="ghost" onClick={() => api("/api/account/sessions/revoke-others", { method: "POST", body: "{}" }).then(load)}>{line(lang, "Sign out other devices", "退出其他设备", "Log keluar peranti lain")}</Button>
          </div>
        </div>
      </div>
    </Shell>
  );
}
