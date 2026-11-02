"use client";

import { useState } from "react";
import { Shell } from "@/components/Shell";
import { api } from "@/lib/api";
import { tri } from "@/lib/tri";
import { useI18n } from "@/lib/i18n";

export default function SecurityPage() {
  const { lang } = useI18n();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [qr, setQr] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  async function start() {
    setError("");
    setDone("");
    try {
      const res = await api<{ qrDataUrl: string; recoveryCodes: string[] }>("/api/admin/security/totp/start", {
        method: "POST",
        body: JSON.stringify({ totp: current }),
      });
      setQr(res.qrDataUrl);
      setCodes(res.recoveryCodes);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function confirm() {
    setError("");
    try {
      await api("/api/admin/security/totp/confirm", { method: "POST", body: JSON.stringify({ totp: next }) });
      setDone(tri(lang, "验证器已更换。恢复码不会再显示。", "Authenticator replaced. Recovery codes will not be shown again.", "Pengesah diganti. Kod pemulihan tidak akan dipaparkan lagi."));
      setQr("");
      setCodes([]);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Shell>
      <div className="page">
        <section className="panel">
          <div className="kicker">RFC 6238</div>
          <h1>{tri(lang, "验证器", "Authenticator", "Pengesah")}</h1>
          <p className="hint">{tri(lang,
            "地址池的每次写入都要所有者验证器上的新验证码，不能复用登录时那一枚。恢复码只显示一次。",
            "Address-pool writes ask for a fresh code from the owner's authenticator, not the code used at login. Recovery codes are shown once.",
            "Setiap tulis kolam alamat minta kod baharu daripada pengesah pemilik, bukan kod log masuk. Kod pemulihan dipaparkan sekali.",
          )}</p>
          {error ? <p className="err">{error}</p> : null}
          {done ? <p className="hint">{done}</p> : null}
          <label>{tri(lang, "当前验证码", "Current code", "Kod semasa")}</label>
          <input className="desk-input" value={current} onChange={(e) => setCurrent(e.target.value)} inputMode="numeric" />
          <div style={{ marginTop: 8 }}><button type="button" className="langbtn" onClick={() => void start()}>{tri(lang, "开始绑定", "Start enrolment", "Mula pendaftaran")}</button></div>
          {qr ? (
            <>
              <img src={qr} alt="TOTP QR" width={180} height={180} />
              <p className="hint">{tri(lang, "请现在保存恢复码。它们只显示这一次。", "Save these recovery codes now. They are shown once.", "Simpan kod pemulihan ini sekarang. Ia dipaparkan sekali.")}</p>
              <ul>{codes.map((code) => <li key={code} className="num">{code}</li>)}</ul>
              <label>{tri(lang, "新验证器上的验证码", "Code from the new authenticator", "Kod daripada pengesah baharu")}</label>
              <input className="desk-input" value={next} onChange={(e) => setNext(e.target.value)} inputMode="numeric" />
              <div style={{ marginTop: 8 }}><button type="button" className="langbtn" onClick={() => void confirm()}>{tri(lang, "确认", "Confirm", "Sahkan")}</button></div>
            </>
          ) : null}
        </section>
      </div>
    </Shell>
  );
}
