"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AccountBack } from "@/components/AccountBack";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { accountCopy } from "@/lib/account-copy";
import { formatUsd } from "@/lib/format";
import { useI18n } from "@/lib/i18n";

type View = {
  code: string;
  tier: { id: string; maker_bps: number; taker_bps: number } | null;
  invites: { id: string; invitee: string; commission_uusd: string }[];
};

export default function ReferralPage() {
  const { lang } = useI18n();
  const copy = accountCopy(lang);
  const [data, setData] = useState<View | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  function load() {
    api<View>("/api/growth").then(setData).catch((err) => setError((err as Error).message));
  }
  useEffect(() => { load(); }, []);

  return (
    <Shell>
      <div className="page">
        <AccountBack />
        <h1>{copy.referral}</h1>
        {error ? <p className="err">{error}</p> : null}
        <section className="panel">
          <p className="kicker">{copy.code}</p>
          <p className="uid-line">
            <b>{data?.code ?? "—"}</b>
            {data?.code ? <button type="button" className="langbtn" onClick={() => { void navigator.clipboard.writeText(data.code); setCopied(true); }}>{copied ? copy.copied : copy.copy}</button> : null}
          </p>
          <p className="hint">{copy.tier} · {data?.tier ? `${data.tier.id} · ${data.tier.maker_bps}/${data.tier.taker_bps} bps` : "—"} · <Link href="/rewards">{copy.feeTiers}</Link></p>
        </section>
        <section className="panel">
          <h2>{copy.claim}</h2>
          <div className="chat-compose">
            <input className="desk-input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="MERIDEX-SG" />
            <Button onClick={() => api("/api/growth/claim", { method: "POST", body: JSON.stringify({ code }) }).then(() => { setCode(""); load(); }).catch((err) => setError((err as Error).message))}>{copy.apply}</Button>
          </div>
        </section>
        <section className="panel">
          <h2>{copy.invites}</h2>
          {(data?.invites ?? []).length === 0 ? <p className="hint">—</p> : data?.invites.map((row) => (
            <p key={row.id} className="hint">{row.invitee} · {formatUsd(row.commission_uusd)}</p>
          ))}
        </section>
      </div>
    </Shell>
  );
}
