"use client";

import Link from "next/link";
import { AccountSlot } from "@/components/AccountSlot";
import { useI18n } from "@/lib/i18n";

export default function RiskPage() {
  const { t } = useI18n();
  return (
    <>
      <div className="announce">{t.announcements}</div>
      <header className="topnav"><Link href="/" className="brand"><span className="mark" /> MERIDEX</Link><AccountSlot /></header>
      <section className="section">
        <h2>{t.riskTitle}</h2>
        <p className="lede">{t.riskBody}</p>
        <p className="hint">{t.indicativeNote}</p>
        <p className="hint">{t.sessionStats}</p>
      </section>
    </>
  );
}
