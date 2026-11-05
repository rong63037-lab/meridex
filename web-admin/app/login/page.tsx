"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { reasonText, useI18n } from "@/lib/i18n";
import { tri } from "@/lib/tri";

export default function AdminLogin() {
  const { t, lang, toggle } = useI18n();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const res = await api<{ token: string; role: string }>("/api/admin/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password, totp }),
      });
      localStorage.setItem("meridex.staff.token", res.token);
      router.push(res.role === "risk" ? "/surveillance" : res.role === "ops" ? "/ops" : res.role === "support" ? "/support" : "/");
    } catch (err) {
      setError(reasonText(lang, (err as Error).message));
    }
  }

  return (
    <div className="admin-app">
      <div className="admin-ribbon">MERIDEX ADMIN · INTERNAL CONSOLE</div>
      <div className="auth-wrap">
        <section className="auth-story">
          <Link href="/login" className="brand"><span className="mark" /> MERIDEX ADMIN</Link>
          <p className="kicker">{tri(lang, "仅员工", "Staff only", "Kakitangan sahaja")}</p>
          <h1>{tri(lang, "内部后台", "Internal console", "Konsol dalaman")}</h1>
          <p className="lede">{tri(lang,
            "一个超级管理员可以处理风控、运营、合规、客服和文案。地址修改只在地址后台。客户账号在这里会被拒绝。",
            "One super-admin covers risk, operations, compliance, support, and content. Address changes stay on the address desk. Customer accounts are refused here.",
            "Seorang super-admin mengurus risiko, operasi, pematuhan, sokongan, dan kandungan. Perubahan alamat kekal di meja alamat. Akaun pelanggan ditolak di sini.",
          )}</p>
          <Button variant="ghost" onClick={toggle}>{t.lang}</Button>
        </section>
        <form className="paper-form" onSubmit={submit} style={{ alignSelf: "center" }}>
          <h1>{tri(lang, "员工登录", "Staff sign in", "Log masuk kakitangan")}</h1>
          <p className="hint">{t.mfaNote}</p>
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
        </form>
      </div>
    </div>
  );
}
