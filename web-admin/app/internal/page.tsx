"use client";

import { useEffect, useState } from "react";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { tri } from "@/lib/tri";
import { useI18n } from "@/lib/i18n";

const BADGE = "INTERNAL TEST / 内部测试";

type Account = {
  id: number;
  email: string;
  name: string;
  disabled: boolean;
  totpEnabled: boolean;
  usdAvailable: string;
  badge: string;
};

type Detail = {
  user: { id: number; email: string; display_name: string | null; disabled: boolean; totp_enabled: boolean };
  balances: { asset: string; available: string; reserved: string }[];
  trades: { id: string; symbol: string; side: string; notional_uusd: string }[];
  moves: { id: string; asset: string; direction: string; amount: string; reason: string }[];
};

type Summary = { accounts: number; trades: number; volumeUusd: string; playUsd: string };

function usd(micro: string): string {
  const n = Number(micro);
  if (!Number.isFinite(n)) return micro;
  return (n / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function InternalTestPage() {
  const { lang } = useI18n();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState(false);
  const [amount, setAmount] = useState("1000.00");
  const [reason, setReason] = useState("");
  const [asset, setAsset] = useState("USD");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function load(id?: number) {
    api<{ accounts: Account[]; summary: Summary }>("/api/admin/internal-test")
      .then((res) => {
        setAccounts(res.accounts);
        setSummary(res.summary);
      })
      .catch((err) => setError((err as Error).message));
    if (id) {
      api<Detail>(`/api/admin/internal-test/${id}`).then(setDetail).catch((err) => setError((err as Error).message));
    }
  }

  useEffect(() => { load(); }, []);

  async function createAccount() {
    setError("");
    setNotice("");
    try {
      const created = await api<{ id: number; totpSecret: string | null }>("/api/admin/internal-test", {
        method: "POST",
        body: JSON.stringify({ email, name, password, totp }),
      });
      setNotice(created.totpSecret ? `${email} · ${created.totpSecret}` : email);
      setEmail("");
      setName("");
      setPassword("");
      load(created.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function move(direction: "credit" | "debit") {
    if (!detail) return;
    setError("");
    try {
      await api(`/api/admin/internal-test/${detail.user.id}/move`, {
        method: "POST",
        body: JSON.stringify({ direction, asset, amount, reason }),
      });
      setReason("");
      load(Number(detail.user.id));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function resetPassword() {
    if (!detail) return;
    const next = window.prompt(tri(lang, "新密码", "New password", "Kata laluan baharu"), "");
    if (!next) return;
    setError("");
    try {
      await api(`/api/admin/internal-test/${detail.user.id}/password`, {
        method: "POST",
        body: JSON.stringify({ password: next }),
      });
      setNotice(tri(lang, "密码已更新", "Password updated", "Kata laluan dikemas kini"));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function toggleDisabled(row: Account) {
    setError("");
    try {
      await api(`/api/admin/internal-test/${row.id}/disabled`, {
        method: "POST",
        body: JSON.stringify({ disabled: !row.disabled }),
      });
      load(detail ? Number(detail.user.id) : undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(row: Account) {
    if (!window.confirm(tri(lang, `删除 ${row.email}？`, `Delete ${row.email}?`, `Padam ${row.email}?`))) return;
    setError("");
    try {
      await api(`/api/admin/internal-test/${row.id}`, { method: "DELETE" });
      if (detail && Number(detail.user.id) === row.id) setDetail(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Shell>
      <div className="page">
        <section className="panel">
          <div className="kicker">{tri(lang, "超级管理员", "Super-admin", "Super-admin")}</div>
          <h1>{tri(lang, "员工测试账户", "Staff test accounts", "Akaun ujian kakitangan")} <span className="internal-badge">{BADGE}</span></h1>
          <p className="hint">{tri(lang,
            "演练资金在单独的账本里。这些账户登录客户站点，按实时参考价练习下单，不进入客户报表。",
            "Play money lives in its own ledger. These accounts sign in on the customer site, trade against the live reference price, and stay out of customer reports.",
            "Wang latihan ada dalam lejar sendiri. Akaun ini log masuk di laman pelanggan, dagang pada harga rujukan, dan tidak masuk laporan pelanggan.",
          )}</p>
          {error ? <p className="err">{error}</p> : null}
          {notice ? <p className="hint">{notice}</p> : null}
          <div className="kpi">
            <article><span>{tri(lang, "账户", "Accounts", "Akaun")}</span><b className="num">{summary?.accounts ?? "—"}</b></article>
            <article><span>{tri(lang, "演练成交", "Play trades", "Dagangan latihan")}</span><b className="num">{summary?.trades ?? "—"}</b></article>
            <article><span>{tri(lang, "演练成交额", "Play volume", "Volum latihan")}</span><b className="num">{summary ? usd(summary.volumeUusd) : "—"}</b></article>
            <article><span>{tri(lang, "演练美元", "Play USD", "USD latihan")}</span><b className="num">{summary ? usd(summary.playUsd) : "—"}</b></article>
          </div>
        </section>
        <section className="panel">
          <h2>{tri(lang, "新建账户", "Add account", "Tambah akaun")}</h2>
          <div className="split">
            <input className="desk-input" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <input className="desk-input" placeholder={tri(lang, "姓名", "name", "nama")} value={name} onChange={(e) => setName(e.target.value)} />
            <input className="desk-input" placeholder={tri(lang, "密码", "password", "kata laluan")} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <label className="hint"><input type="checkbox" checked={totp} onChange={(e) => setTotp(e.target.checked)} /> TOTP</label>
            <Button type="button" onClick={() => void createAccount()}>{tri(lang, "创建", "Create", "Cipta")}</Button>
          </div>
        </section>
        <section className="panel table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th></th><th>Email</th><th>{tri(lang, "姓名", "Name", "Nama")}</th><th>USD</th><th></th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((row) => (
                <tr key={row.id}>
                  <td><span className="internal-badge">{BADGE}</span></td>
                  <td><button type="button" className="langbtn" onClick={() => load(row.id)}>{row.email}</button></td>
                  <td>{row.name}{row.disabled ? tri(lang, " · 已停用", " · disabled", " · dinyahaktif") : ""}{row.totpEnabled ? " · TOTP" : ""}</td>
                  <td className="num">{usd(row.usdAvailable)}</td>
                  <td>
                    <Button size="sm" variant="outline" onClick={() => void toggleDisabled(row)}>{row.disabled ? tri(lang, "启用", "Enable", "Aktifkan") : tri(lang, "停用", "Disable", "Nyahaktif")}</Button>
                    <Button size="sm" variant="ghost" onClick={() => void remove(row)}>{tri(lang, "删除", "Delete", "Padam")}</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {accounts.length === 0 ? <p className="hint">{tri(lang, "还没有员工测试账户。", "No staff test accounts yet.", "Belum ada akaun ujian kakitangan.")}</p> : null}
        </section>
        {detail ? (
          <section className="panel">
            <h2>{detail.user.email} <span className="internal-badge">{BADGE}</span></h2>
            <div className="split">
              <select className="desk-input" value={asset} onChange={(e) => setAsset(e.target.value)}>
                <option>USD</option>
                <option>XAU</option>
                <option>BTC</option>
                <option>ETH</option>
              </select>
              <input className="desk-input" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <input className="desk-input" placeholder={tri(lang, "原因（必填）", "Reason (required)", "Sebab (wajib)")} value={reason} onChange={(e) => setReason(e.target.value)} />
              <Button type="button" onClick={() => void move("credit")}>{tri(lang, "记入", "Credit", "Kredit")}</Button>
              <Button type="button" variant="outline" onClick={() => void move("debit")}>{tri(lang, "记出", "Debit", "Debit")}</Button>
              <Button type="button" variant="outline" onClick={() => void resetPassword()}>{tri(lang, "重置密码", "Reset password", "Set semula kata laluan")}</Button>
            </div>
            <h2>{tri(lang, "演练余额", "Play balances", "Baki latihan")}</h2>
            <ul>
              {detail.balances.map((row) => (
                <li key={row.asset}>{row.asset} {row.asset === "USD" ? usd(row.available) : row.available}</li>
              ))}
              {detail.balances.length === 0 ? <li className="hint">—</li> : null}
            </ul>
            <h2>{tri(lang, "审计", "Audit", "Audit")}</h2>
            <ul>
              {detail.moves.map((row) => (
                <li key={row.id}>{row.direction} {row.asset} {row.asset === "USD" ? usd(row.amount) : row.amount} · {row.reason}</li>
              ))}
              {detail.moves.length === 0 ? <li className="hint">—</li> : null}
            </ul>
          </section>
        ) : null}
      </div>
    </Shell>
  );
}
