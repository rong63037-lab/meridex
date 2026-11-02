"use client";

import { useEffect, useState } from "react";
import { AccountBack } from "@/components/AccountBack";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { CountrySelect } from "@/components/CountrySelect";
import { api } from "@/lib/api";
import { deskCopy } from "@/lib/desk-copy";
import { reasonText, useI18n } from "@/lib/i18n";
import Link from "next/link";

type Me = {
  nationality?: string;
  residenceCountry?: string;
  sanctionsHit?: boolean;
  kycStatus: string;
  kycReason?: string;
  entityId?: string;
  jurisdiction?: string;
};

export default function KycPage() {
  const { t, lang } = useI18n();
  const copy = deskCopy(lang);
  const [me, setMe] = useState<Me | null>(null);
  const [nationality, setNationality] = useState("SG");
  const [residence, setResidence] = useState("SG");
  const [sanctions, setSanctions] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");

  useEffect(() => {
    api<Me>("/api/me").then((data) => {
      setMe(data);
      if (data.nationality) setNationality(data.nationality);
      if (data.residenceCountry) setResidence(data.residenceCountry);
      else if (data.jurisdiction) setResidence(data.jurisdiction);
      if (typeof data.sanctionsHit === "boolean") setSanctions(data.sanctionsHit);
    }).catch((err) => setError((err as Error).message || "MFA_REQUIRED"));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const decision = await api<{ status: string; reason: string; entityId: string | null }>("/api/kyc", {
        method: "POST",
        body: JSON.stringify({ nationality, residenceCountry: residence, sanctionsHit: sanctions }),
      });
      setResult(`${decision.status} · ${decision.reason}${decision.entityId ? ` · ${decision.entityId}` : ""}`);
      setMe(await api<Me>("/api/me"));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const statusLabel = me?.kycStatus === "approved" ? t.approved : me?.kycStatus === "pending" ? (lang === "en" ? "In manual review" : lang === "ms" ? "Dalam semakan manual" : "人工审核中") : me?.kycStatus === "rejected" ? t.rejected : t.none;
  const steps = [
    { on: true, label: t.email },
    { on: Boolean(me && me.kycStatus !== "none"), label: t.residence },
    { on: me?.kycStatus === "approved", label: t.approved },
  ];

  return (
    <Shell>
      <div className="page">
        <AccountBack />
        <form className="panel" onSubmit={submit}>
          <h2>{t.kycTitle}</h2>
          <p className="hint">{t.kycBody}</p>
          <div className="steps-line">{steps.map((step) => <span key={step.label} className={step.on ? "on" : ""}>{step.label}</span>)}</div>
          <p>{t.status}: <span className={`badge ${me?.kycStatus === "approved" ? "ok" : me?.kycStatus === "pending" ? "warn" : "bad"}`}>{statusLabel}</span> {me?.kycReason} {me?.entityId ? `· ${me.entityId}` : ""}</p>
          <div className="split">
            <div>
              <label>{t.nationality}</label>
              <input className="desk-input" value={nationality} maxLength={2} onChange={(e) => setNationality(e.target.value.toUpperCase())} />
            </div>
            <div>
              <label>{t.residence}</label>
              <CountrySelect value={residence} onChange={setResidence} />
            </div>
          </div>
          <label style={{ display: "flex", gap: 8, margin: "12px 0" }}>
            <input type="checkbox" checked={sanctions} onChange={(e) => setSanctions(e.target.checked)} />
            {t.sanctions}
          </label>
          {me?.kycStatus === "approved" ? <p className="hint"><Link href="/funds/deposit">{copy.depositNow}</Link></p> : me?.kycStatus === "pending" ? <p className="hint">{copy.kycWait}</p> : null}
          {error ? <p className="err">{reasonText(lang, error)}</p> : null}
          {result ? <p>{result}</p> : null}
          <Button variant="desk" type="submit">{t.saveKyc}</Button>
        </form>
      </div>
    </Shell>
  );
}
