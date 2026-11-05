"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useLang } from "@/lib/useLang";

export default function PoolLogin() {
  const router = useRouter();
  const { lang, setLang, t } = useLang();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const res = await api<{ token: string }>("/api/pool/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password, totp }),
      });
      localStorage.setItem("meridex.pool.token", res.token);
      router.push("/");
    } catch (err) {
      const code = (err as Error).message;
      setError(code === "INVALID_TOTP" ? t.errTotp : code === "TOTP_LOCKED" ? t.errLocked : t.errGeneric);
    }
  }

  return (
    <div className="admin-app">
      <div className="admin-ribbon">MERIDEX · {t.ribbon}</div>
      <div className="auth-wrap">
        <section className="auth-story">
          <p className="kicker">{t.loginKicker}</p>
          <h1>{t.loginTitle}</h1>
          <p className="lede">{t.loginLede}</p>
        </section>
        <form className="paper-form" onSubmit={submit}>
          <div className="who" style={{ justifyContent: "space-between" }}>
            <h1>{t.loginHeading}</h1>
            <select className="langbtn" aria-label="language" value={lang} onChange={(e) => setLang(e.target.value as "zh" | "en" | "ms")}>
              <option value="zh">中文</option>
              <option value="en">English</option>
              <option value="ms">Melayu</option>
            </select>
          </div>
          <label>{t.email}</label>
          <input className="desk-input" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          <label>{t.password}</label>
          <input className="desk-input" value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" />
          <label>{t.totp}</label>
          <input className="desk-input" value={totp} onChange={(e) => setTotp(e.target.value)} inputMode="numeric" autoComplete="one-time-code" />
          {error ? <p className="desk-banner bad" role="alert">{error}</p> : null}
          <div className="desk-actions">
            <Button type="submit" size="lg">{t.signIn}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
