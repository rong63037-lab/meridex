"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { tri } from "@/lib/tri";
import { useI18n } from "@/lib/i18n";

type DepositRow = {
  id: number;
  userId: number;
  email: string;
  fundId: string;
  name: string;
  internalTest: boolean;
  asset: string;
  network: string;
  amount: string;
  reference: string;
  status: string;
  createdAt: string;
};
type WithdrawRow = {
  id: number;
  userId: number;
  email: string;
  fundId: string;
  name: string;
  internalTest: boolean;
  asset: string;
  network: string;
  address: string;
  amount: string;
  status: string;
  reason: string;
  txHash: string;
  createdAt: string;
};
type Match = { id: number; email: string; fundId?: string; name?: string };

const ASSETS = ["USD", "USDT", "BTC", "ETH", "XAU"] as const;
const NETWORKS: Record<string, string[]> = {
  USD: ["Bank", "PayNow"],
  USDT: ["ERC20", "TRC20"],
  BTC: ["Bitcoin"],
  ETH: ["Ethereum"],
  XAU: ["Vault"],
};

function when(value: string) {
  return value.replace("T", " ").slice(0, 16);
}

function FundsScreen() {
  const { lang } = useI18n();
  const params = useSearchParams();
  const [tab, setTab] = useState(params.get("tab") === "withdrawals" ? "withdrawals" : "deposits");
  const [q, setQ] = useState(params.get("q") ?? "");
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [status, setStatus] = useState("pending");
  const [deposits, setDeposits] = useState<DepositRow[]>([]);
  const [withdrawals, setWithdrawals] = useState<WithdrawRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [credit, setCredit] = useState<DepositRow | null>(null);
  const [amount, setAmount] = useState("");
  const [tx, setTx] = useState("");
  const [totp, setTotp] = useState("");
  const [decide, setDecide] = useState<{ row: WithdrawRow; action: "approve" | "reject" | "sent" } | null>(null);
  const [reasonKind, setReasonKind] = useState("address");
  const [reasonText, setReasonText] = useState("");
  const [manualQ, setManualQ] = useState("");
  const [matches, setMatches] = useState<Match[]>([]);
  const [picked, setPicked] = useState<Match | null>(null);
  const [manualAsset, setManualAsset] = useState("USD");
  const [manualNet, setManualNet] = useState("Bank");
  const [manualAmount, setManualAmount] = useState("");
  const [manualRef, setManualRef] = useState("");
  const [manualTotp, setManualTotp] = useState("");
  const [reverseId, setReverseId] = useState("");
  const [reverseWhy, setReverseWhy] = useState("");
  const [reverseTotp, setReverseTotp] = useState("");
  const [internalHit, setInternalHit] = useState("");

  const t = (zh: string, en: string, ms: string) => tri(lang, zh, en, ms);
  const reasons = [
    { id: "address", label: t("地址不符", "Address does not match", "Alamat tidak sepadan"), text: "地址不符 Address mismatch" },
    { id: "request", label: t("客户要求取消", "Customer asked to cancel", "Pelanggan minta batal"), text: "客户要求取消 Customer request" },
    { id: "compliance", label: t("合规暂缓", "Compliance hold", "Pegangan pematuhan"), text: "合规暂缓 Compliance hold" },
    { id: "other", label: t("其他", "Other", "Lain-lain"), text: "" },
  ];

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(q.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [q]);

  function load(nextTab = tab, nextStatus = status, nextQuery = query) {
    setLoading(true);
    setError("");
    const path = nextTab === "deposits"
      ? `/api/admin/funds/deposits?status=${encodeURIComponent(nextStatus)}&q=${encodeURIComponent(nextQuery)}`
      : `/api/admin/funds/withdrawals?status=${encodeURIComponent(nextStatus)}&q=${encodeURIComponent(nextQuery)}`;
    api<{ deposits?: DepositRow[]; withdrawals?: WithdrawRow[] }>(path)
      .then((res) => {
        setDeposits(res.deposits ?? []);
        setWithdrawals(res.withdrawals ?? []);
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, [tab, status, query]);

  function chooseTab(next: "deposits" | "withdrawals") {
    setTab(next);
    setStatus("pending");
    setSuccess("");
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  }

  async function confirmCredit() {
    if (!credit) return;
    setBusy(true);
    setError("");
    try {
      const res = await api<{ net: string; asset: string; reference: string }>("/api/admin/manual-deposits", {
        method: "POST",
        body: JSON.stringify({
          userId: credit.userId,
          asset: credit.asset,
          network: credit.network,
          amount: amount.trim(),
          reference: credit.reference,
          receivedAt: new Date().toISOString(),
          totp,
          confirm: true,
          claimId: credit.id,
          txHash: tx.trim() || null,
        }),
      });
      setSuccess(t(
        `已入账 ${credit.fundId} ${res.net} ${res.asset}`,
        `Credited ${credit.fundId} ${res.net} ${res.asset}`,
        `Dikreditkan ${credit.fundId} ${res.net} ${res.asset}`,
      ));
      setCredit(null);
      setTotp("");
      setTx("");
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmWithdraw() {
    if (!decide) return;
    setBusy(true);
    setError("");
    try {
      if (decide.action === "sent") {
        await api(`/api/admin/withdrawals/${decide.row.id}/sent`, {
          method: "POST",
          body: JSON.stringify({ totp, txHash: tx.trim() }),
        });
        setSuccess(t(
          `已标记汇出 ${decide.row.fundId}`,
          `Marked sent ${decide.row.fundId}`,
          `Ditanda dihantar ${decide.row.fundId}`,
        ));
        setDecide(null);
      } else if (decide.action === "approve") {
        await api(`/api/admin/withdrawals/${decide.row.id}/approve`, {
          method: "POST",
          body: JSON.stringify({ totp }),
        });
        setSuccess(t(
          `已通过 ${decide.row.fundId}。下一步标记汇出。`,
          `Approved ${decide.row.fundId}. Mark it sent next.`,
          `Diluluskan ${decide.row.fundId}. Tanda dihantar seterusnya.`,
        ));
        setDecide({ row: { ...decide.row, status: "approved" }, action: "sent" });
        setTx("");
      } else {
        const pickedReason = reasons.find((item) => item.id === reasonKind);
        const reason = reasonKind === "other" ? reasonText.trim() : pickedReason?.text ?? "";
        await api(`/api/admin/withdrawals/${decide.row.id}/reject`, {
          method: "POST",
          body: JSON.stringify({ totp, reason }),
        });
        setSuccess(t(`已退回 ${decide.row.fundId}`, `Rejected ${decide.row.fundId}`, `Ditolak ${decide.row.fundId}`));
        setDecide(null);
      }
      setTotp("");
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function findManual() {
    setInternalHit("");
    setPicked(null);
    try {
      const res = await api<{ matches: Match[]; internalTest: Match | null }>(`/api/admin/manual-deposits/customers?q=${encodeURIComponent(manualQ.trim())}`);
      setMatches(res.matches);
      setInternalHit(res.internalTest ? res.internalTest.email : "");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function manualCredit() {
    if (!picked) return;
    setBusy(true);
    setError("");
    try {
      const res = await api<{ net: string; asset: string }>("/api/admin/manual-deposits", {
        method: "POST",
        body: JSON.stringify({
          userId: picked.id,
          asset: manualAsset,
          network: manualNet,
          amount: manualAmount.trim(),
          reference: manualRef.trim(),
          receivedAt: new Date().toISOString(),
          totp: manualTotp,
          confirm: true,
        }),
      });
      setSuccess(t(`已入账 ${res.net} ${res.asset}`, `Credited ${res.net} ${res.asset}`, `Dikreditkan ${res.net} ${res.asset}`));
      setManualTotp("");
      setManualAmount("");
      setManualRef("");
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function reverse() {
    setBusy(true);
    setError("");
    try {
      await api(`/api/admin/manual-deposits/${Number(reverseId)}/reverse`, {
        method: "POST",
        body: JSON.stringify({ reason: reverseWhy.trim(), totp: reverseTotp }),
      });
      setSuccess(t("已冲回。", "Reversed.", "Dibalikkan."));
      setReverseTotp("");
      setReverseWhy("");
      setReverseId("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const depositStatuses = [
    ["pending", t("待入账", "Waiting", "Menunggu")],
    ["credited", t("已入账", "Credited", "Dikreditkan")],
    ["dismissed", t("已忽略", "Dismissed", "Diketepikan")],
    ["all", t("全部", "All", "Semua")],
  ];
  const withdrawStatuses = [
    ["pending", t("待审核", "Waiting", "Menunggu")],
    ["approved", t("已通过", "Approved", "Diluluskan")],
    ["posted", t("已汇出", "Sent", "Dihantar")],
    ["rejected", t("已退回", "Rejected", "Ditolak")],
    ["all", t("全部", "All", "Semua")],
  ];
  const statuses = tab === "deposits" ? depositStatuses : withdrawStatuses;
  const rows = tab === "deposits" ? deposits : withdrawals;

  return (
    <Shell>
      <div className="page">
        <section className="panel">
          <div className="kicker">MERIDEX</div>
          <h1>{t("资金", "Funds", "Dana")}</h1>
          <p className="hint">{t(
            "待处理的入金和出金。入账只在这里发生，聊天不能入账。",
            "Deposits and withdrawals waiting on you. A credit happens only here, never from chat.",
            "Deposit dan pengeluaran yang menunggu. Kredit hanya di sini, bukan dari sembang.",
          )}</p>
          <div className="fund-tabs" role="tablist">
            <button type="button" className={tab === "deposits" ? "on" : ""} onClick={() => chooseTab("deposits")}>{t("入金", "Deposits", "Deposit")}</button>
            <button type="button" className={tab === "withdrawals" ? "on" : ""} onClick={() => chooseTab("withdrawals")}>{t("出金", "Withdrawals", "Pengeluaran")}</button>
          </div>
          <div className="filters">
            <input
              className="desk-input"
              value={q}
              placeholder={t("客户、资金账号、参考号", "Customer, fund ID, reference", "Pelanggan, ID dana, rujukan")}
              onChange={(e) => setQ(e.target.value)}
            />
            <select className="desk-input" value={status} onChange={(e) => setStatus(e.target.value)}>
              {statuses.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </div>
          {error ? <p className="err" role="alert">{error}</p> : null}
          {success ? <p className="okline" role="status">{success}</p> : null}
          {loading ? <p className="hint">{t("正在加载…", "Loading…", "Memuatkan…")}</p> : null}
          {!loading && rows.length === 0 ? <p className="hint">{t("没有记录。", "Nothing here.", "Tiada rekod.")}</p> : null}
          {!loading && rows.length > 0 ? (
            <div className="scroll-table">
              <table>
                <thead>
                  <tr>
                    <th>{t("客户", "Client", "Pelanggan")}</th>
                    <th>{t("资产", "Asset", "Aset")}</th>
                    <th>{t("金额", "Amount", "Jumlah")}</th>
                    <th>{t("参考", "Reference", "Rujukan")}</th>
                    <th>{t("时间", "Time", "Masa")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {tab === "deposits" ? deposits.map((row) => (
                    <tr key={row.id}>
                      <td className="wrap">
                        <Link href={`/customers/${row.userId}`}>{row.name || row.email}</Link>
                        <div className="hint num">{row.fundId}</div>
                        {row.internalTest ? <span className="pill">{t("内部测试", "Internal test", "Ujian dalaman")}</span> : null}
                      </td>
                      <td>{row.asset} · {row.network}</td>
                      <td className="num">{row.amount}</td>
                      <td className="wrap">{row.reference}</td>
                      <td>{when(row.createdAt)}</td>
                      <td>
                        {row.status === "pending" && !row.internalTest ? (
                          <Button size="sm" onClick={() => { setCredit(row); setAmount(row.amount); setTx(""); setTotp(""); setError(""); }}>{t("确认到账并入账", "Confirm and credit", "Sahkan dan kredit")}</Button>
                        ) : <span className="hint">{row.internalTest ? t("不能入账", "Cannot credit", "Tidak boleh kredit") : row.status}</span>}
                      </td>
                    </tr>
                  )) : withdrawals.map((row) => (
                    <tr key={row.id}>
                      <td className="wrap">
                        <Link href={`/customers/${row.userId}`}>{row.name || row.email}</Link>
                        <div className="hint num">{row.fundId}</div>
                        {row.internalTest ? <span className="pill">{t("内部测试", "Internal test", "Ujian dalaman")}</span> : null}
                      </td>
                      <td>{row.asset}{row.network ? ` · ${row.network}` : ""}</td>
                      <td className="num">{row.amount}</td>
                      <td className="wrap">{row.address || row.txHash || "—"}</td>
                      <td>{when(String(row.createdAt))}</td>
                      <td className="actions">
                        {row.status === "pending" ? (
                          <>
                            <Button size="sm" onClick={() => { setDecide({ row, action: "approve" }); setTotp(""); setError(""); }}>{t("通过", "Approve", "Lulus")}</Button>
                            <Button size="sm" variant="outline" onClick={() => { setDecide({ row, action: "reject" }); setTotp(""); setReasonKind("address"); setReasonText(""); setError(""); }}>{t("拒绝", "Reject", "Tolak")}</Button>
                          </>
                        ) : null}
                        {row.status === "approved" ? (
                          <Button size="sm" onClick={() => { setDecide({ row, action: "sent" }); setTx(""); setTotp(""); setError(""); }}>{t("标记已汇出", "Mark as sent", "Tanda dihantar")}</Button>
                        ) : null}
                        {row.status !== "pending" && row.status !== "approved" ? <span className="hint">{row.status}</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <details className="more">
            <summary>{t("更多", "More", "Lagi")}</summary>
            <p className="hint">{t(
              "冲回、没有申报的入账、对账。出金审核金额是文案页的 withdraw.reviewUsd，默认 0，每一笔都要审核。",
              "Reversals, a credit with no claim, and reconciliation. The review amount is withdraw.reviewUsd on the content page. It defaults to 0, so every withdrawal waits.",
              "Pembalikan, kredit tanpa tuntutan, dan penyelarasan. Amaun semakan ialah withdraw.reviewUsd di halaman kandungan. Lalai 0, jadi setiap pengeluaran menunggu.",
            )}</p>
            <p><Link href="/deposits/reconcile">{t("打开对账", "Open reconciliation", "Buka penyelarasan")}</Link> · <Link href="/content">withdraw.reviewUsd</Link></p>
            <h2>{t("没有申报的入账", "Credit with no claim", "Kredit tanpa tuntutan")}</h2>
            <div className="filters">
              <input className="desk-input" value={manualQ} placeholder={t("邮箱或资金账号", "Email or fund ID", "E-mel atau ID dana")} onChange={(e) => setManualQ(e.target.value)} />
              <Button type="button" size="sm" variant="outline" onClick={() => void findManual()}>{t("查找", "Find", "Cari")}</Button>
            </div>
            {internalHit ? <p className="err">{t("内部测试账户不能入账。", "Internal-test accounts cannot be credited.", "Akaun ujian dalaman tidak boleh dikreditkan.")} {internalHit}</p> : null}
            <div className="filters">
              {matches.map((item) => (
                <button type="button" key={item.id} className={picked?.id === item.id ? "pill on" : "pill"} onClick={() => setPicked(item)}>{item.fundId} {item.email}</button>
              ))}
            </div>
            <div className="filters">
              <select className="desk-input" value={manualAsset} onChange={(e) => { setManualAsset(e.target.value); setManualNet(NETWORKS[e.target.value][0]); }}>
                {ASSETS.map((id) => <option key={id}>{id}</option>)}
              </select>
              <select className="desk-input" value={manualNet} onChange={(e) => setManualNet(e.target.value)}>
                {(NETWORKS[manualAsset] ?? []).map((id) => <option key={id}>{id}</option>)}
              </select>
              <input className="desk-input" value={manualAmount} placeholder={t("金额", "Amount", "Jumlah")} onChange={(e) => setManualAmount(e.target.value)} />
              <input className="desk-input" value={manualRef} placeholder={t("参考号", "Reference", "Rujukan")} onChange={(e) => setManualRef(e.target.value)} />
              <input className="desk-input" value={manualTotp} inputMode="numeric" autoComplete="one-time-code" placeholder={t("验证码", "Authenticator", "Pengesah")} onChange={(e) => setManualTotp(e.target.value)} />
              <Button type="button" size="sm" disabled={!picked || busy} onClick={() => void manualCredit()}>{t("入账", "Credit", "Kredit")}</Button>
            </div>
            <h2>{t("冲回一笔入账", "Reverse a credit", "Balikkan kredit")}</h2>
            <div className="filters">
              <input className="desk-input" value={reverseId} placeholder={t("入账编号", "Credit id", "ID kredit")} onChange={(e) => setReverseId(e.target.value)} />
              <input className="desk-input" value={reverseWhy} placeholder={t("原因", "Reason", "Sebab")} onChange={(e) => setReverseWhy(e.target.value)} />
              <input className="desk-input" value={reverseTotp} inputMode="numeric" autoComplete="one-time-code" placeholder={t("验证码", "Authenticator", "Pengesah")} onChange={(e) => setReverseTotp(e.target.value)} />
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void reverse()}>{t("冲回", "Reverse", "Balikkan")}</Button>
            </div>
          </details>
        </section>
        {credit ? (
          <div className="sheet" role="dialog" aria-modal="true">
            <section className="panel">
              <h2>{t("确认到账并入账", "Confirm and credit", "Sahkan dan kredit")}</h2>
              <p className="hint">{credit.email} · {credit.fundId} · {credit.asset} {credit.network}</p>
              <p className="hint">{t("参考号", "Reference", "Rujukan")} {credit.reference}</p>
              <label>{t("到账金额", "Amount received", "Jumlah diterima")}
                <input className="desk-input" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </label>
              <label>{t("链上哈希（可选）", "Tx hash (optional)", "Hash tx (pilihan)")}
                <input className="desk-input" value={tx} onChange={(e) => setTx(e.target.value)} />
              </label>
              <label>{t("验证码", "Authenticator code", "Kod pengesah")}
                <input className="desk-input" value={totp} inputMode="numeric" autoComplete="one-time-code" onChange={(e) => setTotp(e.target.value)} />
              </label>
              {error ? <p className="err">{error}</p> : null}
              <div className="filters">
                <Button type="button" disabled={busy || !amount.trim() || totp.length < 6} onClick={() => void confirmCredit()}>{t("确认到账并入账", "Confirm and credit", "Sahkan dan kredit")}</Button>
                <Button type="button" variant="ghost" onClick={() => setCredit(null)}>{t("取消", "Cancel", "Batal")}</Button>
              </div>
            </section>
          </div>
        ) : null}
        {decide ? (
          <div className="sheet" role="dialog" aria-modal="true">
            <section className="panel">
              <h2>{decide.action === "approve" ? t("通过出金", "Approve withdrawal", "Lulus pengeluaran") : decide.action === "reject" ? t("拒绝出金", "Reject withdrawal", "Tolak pengeluaran") : t("标记已汇出", "Mark as sent", "Tanda dihantar")}</h2>
              <p className="hint">{decide.row.email} · {decide.row.fundId} · {decide.row.amount} {decide.row.asset}</p>
              {decide.action === "reject" ? (
                <>
                  <label>{t("原因", "Reason", "Sebab")}
                    <select className="desk-input" value={reasonKind} onChange={(e) => setReasonKind(e.target.value)}>
                      {reasons.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                    </select>
                  </label>
                  {reasonKind === "other" ? <input className="desk-input" value={reasonText} onChange={(e) => setReasonText(e.target.value)} placeholder={t("写下原因", "Write the reason", "Tulis sebab")} /> : null}
                </>
              ) : null}
              {decide.action === "sent" ? (
                <label>{t("链上哈希", "Tx hash", "Hash tx")}
                  <input className="desk-input" value={tx} onChange={(e) => setTx(e.target.value)} />
                </label>
              ) : null}
              <label>{t("验证码", "Authenticator code", "Kod pengesah")}
                <input className="desk-input" value={totp} inputMode="numeric" autoComplete="one-time-code" onChange={(e) => setTotp(e.target.value)} />
              </label>
              {error ? <p className="err">{error}</p> : null}
              <div className="filters">
                <Button type="button" disabled={busy || totp.length < 6 || (decide.action === "sent" && tx.trim().length < 4) || (decide.action === "reject" && reasonKind === "other" && reasonText.trim().length < 1)} onClick={() => void confirmWithdraw()}>
                  {decide.action === "approve" ? t("通过", "Approve", "Lulus") : decide.action === "reject" ? t("拒绝", "Reject", "Tolak") : t("标记已汇出", "Mark as sent", "Tanda dihantar")}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setDecide(null)}>{t("取消", "Cancel", "Batal")}</Button>
              </div>
            </section>
          </div>
        ) : null}
      </div>
    </Shell>
  );
}

export default function FundsPage() {
  return (
    <Suspense fallback={<p className="hint">…</p>}>
      <FundsScreen />
    </Suspense>
  );
}
