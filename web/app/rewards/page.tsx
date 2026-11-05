"use client";

import { useEffect, useState } from "react";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { formatUsd } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { tri } from "@/lib/tri";

type View = {
  code: string;
  points: number;
  volumeUusd: string;
  holdUusd: string;
  regulatory: string;
  tier: { id: string; maker_bps: number; taker_bps: number } | null;
  tiers: { id: string; min_volume_uusd: string; maker_bps: number; taker_bps: number }[];
  tasks: { code: string; title_zh: string; title_en: string; points: number; status: string; needs_approval: boolean }[];
  invites: { id: string; invitee: string; commission_uusd: string }[];
};

export default function RewardsPage() {
  const { lang } = useI18n();
  const [data, setData] = useState<View | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  function load() {
    api<View>("/api/growth").then(setData).catch((err) => setError((err as Error).message));
  }
  useEffect(() => { load(); }, []);

  return (
    <Shell>
      <div className="page">
        <section className="panel">
          <div className="kicker">VIP</div>
          <h1>{tri(lang, "邀请与费率", "Invite and fees", "Jemputan dan yuran")}</h1>
          <p className="hint">{data?.regulatory}</p>
          <span className="sim-flag">{tri(lang, "奖励可能需要监管批准", "Rewards may need regulatory approval", "Ganjaran mungkin perlu kelulusan kawal selia")}</span>
          {error ? <p className="err">{error}</p> : null}
          <div className="kpi">
            <article><span>{tri(lang, "邀请码", "Code", "Kod")}</span><b>{data?.code ?? "—"}</b></article>
            <article><span>{tri(lang, "等级", "Tier", "Tahap")}</span><b>{data?.tier?.id ?? "—"}</b></article>
            <article><span>{tri(lang, "30 日成交", "30-day volume", "Volum 30 hari")}</span><b className="num">{data ? formatUsd(data.volumeUusd) : "—"}</b></article>
            <article><span>{tri(lang, "积分", "Points", "Mata")}</span><b className="num">{data?.points ?? "—"}</b></article>
          </div>
          <p className="hint">{tri(lang, "美元可用", "Cash holdings", "Pegangan USD")} {data ? formatUsd(data.holdUusd) : "—"} · maker/taker {data?.tier ? `${data.tier.maker_bps}/${data.tier.taker_bps} bps` : "—"}</p>
        </section>
        <section className="panel">
          <h2>{tri(lang, "等级", "Tiers", "Tahap")}</h2>
          <table className="table">
            <tbody>
              {(data?.tiers ?? []).map((row) => (
                <tr key={row.id}><td>{row.id}</td><td className="num">{formatUsd(row.min_volume_uusd)}</td><td className="num">{row.maker_bps}/{row.taker_bps}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="panel">
          <h2>{tri(lang, "新户任务", "Tasks", "Tugas akaun baharu")}</h2>
          {(data?.tasks ?? []).map((task) => (
            <p key={task.code} className="hint">
              {lang === "zh" ? task.title_zh : task.title_en} · {task.points} · {task.status}
              {task.needs_approval ? tri(lang, " · 需审批", " · needs approval", " · perlu kelulusan") : ""}
              {task.status === "open" ? (
                <Button size="sm" variant="outline" onClick={() => api(`/api/growth/tasks/${task.code}`, { method: "POST", body: "{}" }).then(load)}>{tri(lang, "领取", "Claim", "Tuntut")}</Button>
              ) : null}
            </p>
          ))}
        </section>
        <section className="panel">
          <h2>{tri(lang, "填写邀请码", "Claim an invite", "Isi kod jemputan")}</h2>
          <div className="chat-compose">
            <input className="desk-input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="MERIDEX-SG" />
            <Button onClick={() => api("/api/growth/claim", { method: "POST", body: JSON.stringify({ code }) }).then(load).catch((err) => setError((err as Error).message))}>{tri(lang, "绑定", "Apply", "Ikat")}</Button>
          </div>
          {(data?.invites ?? []).map((row) => (
            <p key={row.id} className="hint">{row.invitee} · {tri(lang, "佣金", "commission", "komisen")} {formatUsd(row.commission_uusd)}</p>
          ))}
        </section>
      </div>
    </Shell>
  );
}
