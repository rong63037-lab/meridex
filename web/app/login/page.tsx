"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { LangSelect, reasonText, useI18n } from "@/lib/i18n";

function AuthSide() {
  const { lang } = useI18n();
  const say = (zh: string, en: string, ms: string) => (lang === "en" ? en : lang === "ms" ? ms : zh);
  return (
    <aside className="auth-side">
      <Link href="/" className="brand"><span className="mark" /> MERIDEX</Link>
      <div className="auth-side-copy">
        <h2>{say("一个账户，交易贵金属与数字资产", "One account for metals and digital assets", "Satu akaun untuk logam dan aset digital")}</h2>
        <ul>
          <li>{say("每次登录都需要 2FA 动态码", "2FA code required on every sign-in", "Kod 2FA diperlukan setiap log masuk")}</li>
          <li>{say("行情、交易、资产一站管理", "Markets, trading and assets in one place", "Pasaran, dagangan dan aset di satu tempat")}</li>
          <li>{say("中文 / English / Bahasa Melayu", "中文 / English / Bahasa Melayu", "中文 / English / Bahasa Melayu")}</li>
        </ul>
      </div>
      <p className="auth-side-foot">{say("沙盒环境 · 牌照申请中", "Sandbox · licence application in progress", "Kotak pasir · permohonan lesen sedang diproses")}</p>
    </aside>
  );
}

export default function LoginPage() {
  const { t, lang } = useI18n();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const res = await api<{ token: string; role: string }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password, totp }),
      });
      localStorage.setItem("meridex.token", res.token);
      const next = localStorage.getItem("meridex.next");
      localStorage.removeItem("meridex.next");
      if (next) {
        router.push(next);
        return;
      }
      const me = await api<{ kycStatus: string }>("/api/me");
      router.push(me.kycStatus === "approved" ? "/terminal" : "/kyc");
    } catch (err) {
      setError(reasonText(lang, (err as Error).message));
    }
  }

  return (
    <>
      <div className="announce">{t.announcements}</div>
      <div className="auth-wrap auth-slim auth-split">
      <AuthSide />
        <form className="paper-form" onSubmit={submit}>
          <div className="uid-line"><Link href="/" className="brand"><span className="mark" /> MERIDEX</Link><LangSelect /></div>
          <h1>{t.login}</h1>
          <p className="hint">{t.mfaKicker ?? t.mfaNote}</p>
          <label>{t.email}</label>
          <Input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          <label style={{ display: "block", marginTop: 10 }}>{t.password}</label>
          <Input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" />
          <label style={{ display: "block", marginTop: 10 }}>{t.totp}</label>
          <Input value={totp} onChange={(e) => setTotp(e.target.value)} inputMode="numeric" autoComplete="one-time-code" />
          {error ? <p className="err">{error}</p> : null}
          <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
            <Button type="submit">{t.login}</Button>
          </div>
          <p style={{ marginTop: 16 }}><Link href="/register">{t.needAccount}</Link></p>
        </form>
      </div>
    </>
  );
}
