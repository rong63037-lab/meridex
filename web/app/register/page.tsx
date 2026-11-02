"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CountrySelect } from "@/components/CountrySelect";
import { api } from "@/lib/api";
import { deskCopy } from "@/lib/desk-copy";
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

export default function RegisterPage() {
  const { t, lang } = useI18n();
  const copy = deskCopy(lang);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [residence, setResidence] = useState("SG");
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ totpSecret: string; qrDataUrl: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const res = await api<{ totpSecret: string; qrDataUrl: string }>("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ email, password, residenceCountry: residence }),
      });
      localStorage.setItem("meridex.next", "/kyc");
      setCreated(res);
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
        <h1>{t.register}</h1>
        <p className="hint">{copy.saveCode}</p>
        {created ? (
          <>
            <p>{t.secretOnce}</p>
            <img className="qr" alt="TOTP" src={created.qrDataUrl} />
            <p><code>{created.totpSecret}</code></p>
            <Button type="button" onClick={() => navigator.clipboard.writeText(created.totpSecret)}>{t.copy}</Button>
            <p><Link href="/login">{t.goLogin}</Link></p>
          </>
        ) : (
          <>
            <label>{t.email}</label>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
            <label style={{ display: "block", marginTop: 10 }}>{t.residencePick}</label>
            <CountrySelect value={residence} onChange={setResidence} />
            <label style={{ display: "block", marginTop: 10 }}>{t.password}</label>
            <Input value={password} onChange={(e) => setPassword(e.target.value)} type="password" minLength={10} required />
            {error ? <p className="err">{error}</p> : null}
            <div style={{ marginTop: 16 }}><Button type="submit">{t.create}</Button></div>
            <p><Link href="/login">{t.haveAccount}</Link></p>
          </>
        )}
      </form>
      </div>
    </>
  );
}
