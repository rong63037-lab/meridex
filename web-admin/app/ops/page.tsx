"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { tri } from "@/lib/tri";
import { useI18n } from "@/lib/i18n";

type Overview = {
  customers: number;
  frozen: number;
  pendingChanges: number;
  fees: { vip_tier: string; maker_bps: number; taker_bps: number }[];
  instruments: { symbol: string; tick_size: string; lot_size: string; band_bps: number; status: string }[];
  announcements: { id: string; title: string; active: boolean }[];
  campaigns: { id: string; name: string; reward_points: number; active: boolean }[];
  changes: { id: string; kind: string; status: string; payload?: { region?: string; field?: string; access?: string }; maker_email: string; checker_email: string | null }[];
};
type Person = { id: number; email: string; jurisdiction: string | null; frozen: boolean; kyc_status: string | null; kyc_tier: string };

export default function OpsPage() {
  const { lang } = useI18n();
  const [data, setData] = useState<Overview | null>(null);
  const [q, setQ] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");

  function load() {
    api<Overview>("/api/admin/ops/overview").then(setData).catch((err) => setError((err as Error).message));
    api<{ users: Person[] }>(`/api/admin/ops/users?q=${encodeURIComponent(q)}`).then((res) => setPeople(res.users)).catch(() => undefined);
  }
  useEffect(() => { load(); }, []);

  async function proposeFreeze(frozen: boolean) {
    setError("");
    try {
      await api("/api/admin/ops/changes", {
        method: "POST",
        body: JSON.stringify({ kind: "freeze_user", payload: { email, frozen, reason: frozen ? "运营发起冻结" : "运营发起解冻" } }),
      });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Shell>
      <div className="page">
        <section className="panel">
          <div className="kicker">{tri(lang, "运营", "Operations", "Operasi")}</div>
          <h1>{tri(lang, "运营后台", "Back office", "Pejabat operasi")}</h1>
          <p className="hint">{tri(lang,
            "超级管理员可以自己通过自己提交的变更，并通过审计记录留下痕迹。运营账号仍然需要另一名运营复核。",
            "A super-admin can approve their own change. That approval is written to the audit log. Ops still need a second operator.",
            "Super-admin boleh meluluskan perubahan sendiri. Kelulusan itu ditulis dalam log audit. Akaun ops masih perlukan operator kedua.",
          )}</p>
          {error ? <p className="err">{error}</p> : null}
          <div className="kpi">
            <article><span>{tri(lang, "客户", "Customers", "Pelanggan")}</span><b className="num">{data?.customers ?? "—"}</b></article>
            <article><span>{tri(lang, "冻结", "Frozen", "Dibekukan")}</span><b className="num">{data?.frozen ?? "—"}</b></article>
            <article><span>{tri(lang, "待复核", "Pending", "Menunggu")}</span><b className="num">{data?.pendingChanges ?? "—"}</b></article>
          </div>
          <p><Link href="/ops/reports">{tri(lang, "报表与 CSV", "Reports and CSV", "Laporan dan CSV")}</Link></p>
        </section>
        <section className="panel">
          <h2>{tri(lang, "客户", "Customers", "Pelanggan")}</h2>
          <div className="chat-compose">
            <input className="desk-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="email" />
            <Button variant="outline" onClick={load}>{tri(lang, "查找", "Search", "Cari")}</Button>
          </div>
          <table className="table">
            <tbody>
              {people.map((row) => (
                <tr key={row.id}>
                  <td>{row.email}</td>
                  <td>{row.jurisdiction}</td>
                  <td>{row.kyc_tier} · {row.kyc_status}</td>
                  <td>{row.frozen ? tri(lang, "已冻结", "frozen", "dibekukan") : tri(lang, "正常", "open", "terbuka")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="chat-compose">
            <input className="desk-input" value={email} onChange={(e) => setEmail(e.target.value)} />
            <Button onClick={() => void proposeFreeze(true)}>{tri(lang, "提交冻结", "Propose freeze", "Cadang beku")}</Button>
            <Button variant="outline" onClick={() => void proposeFreeze(false)}>{tri(lang, "提交解冻", "Propose unfreeze", "Cadang nyahbeku")}</Button>
          </div>
        </section>
        <div className="split">
          <section className="panel">
            <h2>{tri(lang, "费率 / VIP", "Fee schedule", "Jadual yuran")}</h2>
            <table className="table">
              <tbody>
                {(data?.fees ?? []).map((row) => (
                  <tr key={row.vip_tier}><td>{row.vip_tier}</td><td className="num">{row.maker_bps} / {row.taker_bps} bps</td></tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="panel">
            <h2>{tri(lang, "合约", "Instruments", "Kontrak")}</h2>
            <table className="table">
              <tbody>
                {(data?.instruments ?? []).map((row) => (
                  <tr key={row.symbol}><td>{row.symbol}</td><td>{row.status}</td><td className="num">{row.band_bps} bps</td></tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
        <section className="panel">
          <h2>{tri(lang, "公告与活动", "Announcements and campaigns", "Pengumuman dan kempen")}</h2>
          {(data?.announcements ?? []).map((row) => <p key={row.id} className="hint">{row.title}</p>)}
          {(data?.campaigns ?? []).map((row) => <p key={row.id} className="hint">{row.name} · {row.reward_points} pts</p>)}
        </section>
        <section className="panel">
          <h2>{tri(lang, "复核队列", "Change queue", "Barisan semakan")}</h2>
          <table className="table">
            <tbody>
              {(data?.changes ?? []).map((row) => (
                <tr key={row.id}>
                  <td>{row.kind}{row.kind === "jurisdiction_bulk" && row.payload ? ` · ${row.payload.region} ${row.payload.field} ${row.payload.access}` : ""}</td>
                  <td>{row.status}</td>
                  <td>{row.maker_email}</td>
                  <td>{row.checker_email ?? "—"}</td>
                  <td>{row.status === "pending" ? (
                    <Button size="sm" onClick={() => api(`/api/admin/ops/changes/${row.id}`, { method: "POST", body: JSON.stringify({ action: "approve", reason: "复核通过" }) }).then(load).catch((err) => setError((err as Error).message))}>
                      {tri(lang, "通过", "Approve", "Lulus")}
                    </Button>
                  ) : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </Shell>
  );
}
