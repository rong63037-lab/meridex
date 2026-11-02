"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { api, authHeaders } from "@/lib/api";
import { tri } from "@/lib/tri";
import { useI18n } from "@/lib/i18n";

type MoneyRow = {
  at: string;
  asset: string;
  network: string;
  amount: string;
  address: string;
  reference: string;
  txHash: string;
  status: string;
  actor: string;
  reason: string;
};
type Profile = {
  customer: {
    id: number;
    fundId: string;
    email: string;
    name: string;
    phone: string;
    createdAt: string;
    kycStatus: string;
    kycTier: string;
    kycReason: string;
    country: string;
    nationality: string;
    riskFlags: string[];
    status: string;
    freezeReason: string;
    internalTest: boolean;
    staff: boolean;
    totpEnabled: boolean;
    manager: { email: string; fundId: string } | null;
    referralCode: string;
    referrer: { email: string; fundId: string } | null;
    vipDesk: boolean;
  };
  balances: { asset: string; spotText: string; reservedText: string; withdrawHoldText: string; marginText: string; derivativesText: string; usdText: string }[];
  usdTotalText: string;
  usdPartial: boolean;
  totals: { asset: string; depositedText: string; withdrawnText: string; netText: string }[];
  deposits: MoneyRow[];
  withdrawals: MoneyRow[];
  addresses: { asset: string; network: string; address: string; memo: string }[];
  bank: { name: string; account: string; legacyReference: string } | null;
  orders: { engine_order_id: string; side: string; order_type: string; status: string; qty_mg: string; created_at: string }[];
  trades: { id: number; side: string; notional_uusd: string; tape_at: string }[];
  positions: { id: number; product: string; symbol: string; side: string; qty: string; leverage: number; status: string }[];
  liveOrders: { id: number; product: string; symbol: string; side: string; status: string }[];
  logins: { ip: string; country: string; userAgent: string; at: string }[];
  tickets: { id: string; subject: string; status: string; at: string }[];
  notes: { id: number; body: string; actor: string; at: string }[];
};

function when(value: string) {
  return String(value).replace("T", " ").slice(0, 16);
}

export default function CustomerDetailPage() {
  const { lang } = useI18n();
  const t = (zh: string, en: string, ms: string) => tri(lang, zh, en, ms);
  const params = useParams<{ id: string }>();
  const id = String(params.id ?? "");
  const [data, setData] = useState<Profile | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [totp, setTotp] = useState("");
  const [busy, setBusy] = useState(false);

  function load() {
    setError("");
    api<Profile>(`/api/admin/customers/${encodeURIComponent(id)}`)
      .then(setData)
      .catch((err) => setError((err as Error).message));
  }

  useEffect(() => { if (id) load(); }, [id]);

  async function saveNote() {
    setBusy(true);
    setError("");
    try {
      await api(`/api/admin/customers/${encodeURIComponent(id)}/notes`, { method: "POST", body: JSON.stringify({ body: note.trim() }) });
      setNote("");
      setSuccess(t("备注已保存。", "Note saved.", "Nota disimpan."));
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function freeze(frozen: boolean) {
    setBusy(true);
    setError("");
    try {
      await api(`/api/admin/customers/${encodeURIComponent(id)}/freeze`, {
        method: "POST",
        body: JSON.stringify({ frozen, reason: reason.trim(), totp }),
      });
      setTotp("");
      setSuccess(frozen ? t("已冻结。", "Frozen.", "Dibeku.") : t("已解冻。", "Unfrozen.", "Dinyahbeku."));
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function download(kind: "deposits" | "withdrawals") {
    const res = await fetch(`/api/admin/customers/${encodeURIComponent(id)}/${kind}.csv`, { headers: authHeaders() });
    if (!res.ok) {
      setError(String(res.status));
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${data?.customer.fundId ?? id}-${kind}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const c = data?.customer;

  return (
    <Shell>
      <div className="page">
        <section className="panel">
          <p className="hint"><Link href="/customers">{t("客户", "Customers", "Pelanggan")}</Link></p>
          {error ? <p className="err" role="alert">{error}</p> : null}
          {success ? <p className="okline" role="status">{success}</p> : null}
          {!data && !error ? <p className="hint">{t("正在加载…", "Loading…", "Memuatkan…")}</p> : null}
          {c ? (
            <>
              <h1>{c.name || c.email}</h1>
              <p className="num fund-id">{c.fundId}</p>
              <p>
                {c.internalTest ? <span className="pill">{t("内部测试", "Internal test", "Ujian dalaman")}</span> : null}
                {c.staff ? <span className="pill">{t("员工", "Staff", "Kakitangan")}</span> : null}
                <span className="pill">{c.status === "frozen" ? t("冻结", "Frozen", "Dibeku") : c.status === "disabled" ? t("停用", "Disabled", "Dilumpuhkan") : t("正常", "Active", "Aktif")}</span>
              </p>
              <dl className="facts">
                <div><dt>UID</dt><dd className="num">{c.id}</dd></div>
                <div><dt>{t("邮箱", "Email", "E-mel")}</dt><dd>{c.email}</dd></div>
                <div><dt>{t("电话", "Phone", "Telefon")}</dt><dd>{c.phone || "—"}</dd></div>
                <div><dt>{t("注册", "Registered", "Daftar")}</dt><dd>{when(c.createdAt)}</dd></div>
                <div><dt>KYC</dt><dd>{c.kycStatus} · {c.kycTier}{c.kycReason ? ` · ${c.kycReason}` : ""}</dd></div>
                <div><dt>{t("国家", "Country", "Negara")}</dt><dd>{c.country || "—"}{c.nationality ? ` · ${c.nationality}` : ""}</dd></div>
                <div><dt>{t("风险", "Risk", "Risiko")}</dt><dd>{c.riskFlags.length ? c.riskFlags.join(", ") : t("无", "None", "Tiada")}</dd></div>
                <div><dt>{t("客户经理", "Account manager", "Pengurus akaun")}</dt><dd>{c.manager ? c.manager.email : "—"}</dd></div>
                <div><dt>{t("推荐", "Referral", "Rujukan")}</dt><dd>{c.referrer ? `${c.referrer.email} ${c.referrer.fundId}` : c.referralCode || "—"}</dd></div>
                <div><dt>{t("双重验证", "Authenticator", "Pengesah")}</dt><dd>{c.totpEnabled ? t("已开启", "On", "Hidup") : t("已关闭", "Off", "Mati")}</dd></div>
              </dl>
              <div className="filters">
                <Link href={`/funds?tab=deposits&q=${encodeURIComponent(c.fundId)}`}>{t("看此人的入金", "Deposits for this customer", "Deposit pelanggan ini")}</Link>
                <Link href={`/funds?tab=withdrawals&q=${encodeURIComponent(c.fundId)}`}>{t("看此人的出金", "Withdrawals for this customer", "Pengeluaran pelanggan ini")}</Link>
                <Link href={`/support?user=${c.id}&email=${encodeURIComponent(c.email)}`}>{t("打开会话", "Open chat", "Buka sembang")}</Link>
              </div>
            </>
          ) : null}
        </section>
        {data ? (
          <>
            <section className="panel">
              <h2>{t("余额", "Balances", "Baki")}</h2>
              <p className="num">{data.usdTotalText} USD{data.usdPartial ? " *" : ""}</p>
              {data.balances.length === 0 ? <p className="hint">{t("没有余额。", "No balance.", "Tiada baki.")}</p> : (
                <div className="scroll-table">
                  <table>
                    <thead>
                      <tr>
                        <th>{t("资产", "Asset", "Aset")}</th>
                        <th>{t("现货", "Spot", "Spot")}</th>
                        <th>{t("冻结", "Reserved", "Ditahan")}</th>
                        <th>{t("出金冻结", "Withdraw hold", "Tahan keluar")}</th>
                        <th>{t("杠杆", "Margin", "Margin")}</th>
                        <th>{t("合约", "Derivatives", "Derivatif")}</th>
                        <th>USD</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.balances.map((row) => (
                        <tr key={row.asset}>
                          <td>{row.asset}</td>
                          <td className="num">{row.spotText}</td>
                          <td className="num">{row.reservedText}</td>
                          <td className="num">{row.withdrawHoldText}</td>
                          <td className="num">{row.marginText}</td>
                          <td className="num">{row.derivativesText}</td>
                          <td className="num">{row.usdText}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section className="panel">
              <h2>{t("入金与出金合计", "Deposit and withdrawal totals", "Jumlah deposit dan pengeluaran")}</h2>
              {data.totals.length === 0 ? <p className="hint">{t("账本上还没有入金或出金。", "No deposit or withdrawal on the ledger yet.", "Belum ada deposit atau pengeluaran pada lejar.")}</p> : (
                <ul className="plain-list">
                  {data.totals.map((row) => (
                    <li key={row.asset}>{row.asset} · {t("入金", "Deposited", "Deposit")} {row.depositedText} · {t("出金", "Withdrawn", "Keluar")} {row.withdrawnText} · {t("净额", "Net", "Bersih")} {row.netText}</li>
                  ))}
                </ul>
              )}
            </section>
            <History title={t("入金记录", "Deposits", "Deposit")} rows={data.deposits} onCsv={() => void download("deposits")} csvLabel={t("导出 CSV", "Export CSV", "Eksport CSV")} empty={t("没有入金。", "No deposits.", "Tiada deposit.")} heads={[t("时间", "Time", "Masa"), t("资产", "Asset", "Aset"), t("金额", "Amount", "Jumlah"), t("地址或参考", "Address or reference", "Alamat atau rujukan"), t("哈希", "Tx", "Tx"), t("状态", "Status", "Status"), t("操作人", "By", "Oleh")]} />
            <History title={t("出金记录", "Withdrawals", "Pengeluaran")} rows={data.withdrawals} onCsv={() => void download("withdrawals")} csvLabel={t("导出 CSV", "Export CSV", "Eksport CSV")} empty={t("没有出金。", "No withdrawals.", "Tiada pengeluaran.")} heads={[t("时间", "Time", "Masa"), t("资产", "Asset", "Aset"), t("金额", "Amount", "Jumlah"), t("地址或参考", "Address or reference", "Alamat atau rujukan"), t("哈希", "Tx", "Tx"), t("状态", "Status", "Status"), t("操作人", "By", "Oleh")]} />
            <section className="panel">
              <h2>{t("充值地址", "Deposit addresses", "Alamat deposit")}</h2>
              {data.bank ? <p>{data.bank.name} · <span className="num">{data.bank.account}</span> · {c?.fundId}</p> : null}
              {data.addresses.length === 0 ? <p className="hint">{t("还没有分配地址。", "No address assigned yet.", "Belum ada alamat.")}</p> : (
                <ul className="plain-list">
                  {data.addresses.map((row) => <li key={`${row.asset}-${row.network}`}>{row.asset} {row.network} · <span className="num">{row.address}</span>{row.memo ? ` · ${row.memo}` : ""}</li>)}
                </ul>
              )}
            </section>
            <section className="panel">
              <h2>{t("近期交易", "Recent trades", "Dagangan terkini")}</h2>
              {data.positions.length === 0 && data.orders.length === 0 && data.trades.length === 0 && data.liveOrders.length === 0 ? <p className="hint">{t("没有持仓或近期订单。", "No open position or recent order.", "Tiada posisi terbuka atau pesanan terkini.")}</p> : null}
              {data.positions.map((row) => <p key={`p${row.id}`}>{row.product} {row.symbol} {row.side} ×{row.leverage} · {row.qty}</p>)}
              {data.liveOrders.map((row) => <p key={`l${row.id}`}>{row.product} {row.symbol} {row.side} · {row.status}</p>)}
              {data.orders.map((row) => <p key={row.engine_order_id}>{when(String(row.created_at))} {row.side} {row.order_type} · {row.status}</p>)}
              {data.trades.map((row) => <p key={row.id}>{when(String(row.tape_at))} {row.side}</p>)}
            </section>
            <section className="panel">
              <h2>{t("登录", "Logins", "Log masuk")}</h2>
              {data.logins.length === 0 ? <p className="hint">{t("没有登录记录。", "No login yet.", "Belum ada log masuk.")}</p> : (
                <ul className="plain-list">
                  {data.logins.map((row, i) => <li key={i}>{when(row.at)} · {row.ip || "—"} {row.country} · {row.userAgent}</li>)}
                </ul>
              )}
            </section>
            <section className="panel">
              <h2>{t("工单", "Tickets", "Tiket")}</h2>
              {data.tickets.length === 0 ? <p className="hint">{t("没有工单。", "No tickets.", "Tiada tiket.")}</p> : (
                <ul className="plain-list">
                  {data.tickets.map((row) => <li key={row.id}><Link href={`/support?user=${c?.id}&email=${encodeURIComponent(c?.email ?? "")}`}>{row.subject}</Link> · {row.status} · {when(row.at)}</li>)}
                </ul>
              )}
            </section>
            <section className="panel">
              <h2>{t("内部备注", "Internal notes", "Nota dalaman")}</h2>
              {data.notes.length === 0 ? <p className="hint">{t("还没有备注。", "No notes yet.", "Belum ada nota.")}</p> : (
                <ul className="plain-list">
                  {data.notes.map((row) => <li key={row.id}><b>{row.actor}</b> · {when(row.at)}<br />{row.body}</li>)}
                </ul>
              )}
              <label>{t("添加备注", "Add a note", "Tambah nota")}
                <textarea className="desk-input" value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
              <Button type="button" size="sm" disabled={busy || note.trim().length < 1} onClick={() => void saveNote()}>{t("保存备注", "Save note", "Simpan nota")}</Button>
            </section>
            <section className="panel">
              <h2>{c?.status === "frozen" ? t("解冻", "Unfreeze", "Nyahbeku") : t("冻结", "Freeze", "Bekukan")}</h2>
              <p className="hint">{t(
                "冻结走运营变更。所有者用一次验证码即可通过。",
                "A freeze is an operations change. The owner approves it with one authenticator code.",
                "Pembekuan ialah perubahan operasi. Pemilik meluluskannya dengan satu kod pengesah.",
              )}</p>
              <div className="filters">
                <input className="desk-input" value={reason} placeholder={t("原因", "Reason", "Sebab")} onChange={(e) => setReason(e.target.value)} />
                <input className="desk-input" value={totp} inputMode="numeric" autoComplete="one-time-code" placeholder={t("验证码", "Authenticator", "Pengesah")} onChange={(e) => setTotp(e.target.value)} />
                {c?.status === "frozen" ? (
                  <Button type="button" size="sm" disabled={busy || totp.length < 6} onClick={() => void freeze(false)}>{t("解冻", "Unfreeze", "Nyahbeku")}</Button>
                ) : (
                  <Button type="button" size="sm" variant="outline" disabled={busy || totp.length < 6 || reason.trim().length < 3} onClick={() => void freeze(true)}>{t("冻结", "Freeze", "Bekukan")}</Button>
                )}
              </div>
            </section>
          </>
        ) : null}
      </div>
    </Shell>
  );
}

function History({ title, rows, onCsv, csvLabel, empty, heads }: { title: string; rows: MoneyRow[]; onCsv: () => void; csvLabel: string; empty: string; heads: string[] }) {
  return (
    <section className="panel">
      <div className="section-head">
        <h2>{title}</h2>
        <button type="button" className="langbtn" onClick={onCsv}>{csvLabel}</button>
      </div>
      {rows.length === 0 ? <p className="hint">{empty}</p> : (
        <div className="scroll-table">
          <table>
            <thead>
              <tr>
                {heads.map((head) => <th key={head}>{head}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={`${row.at}-${i}`}>
                  <td>{when(row.at)}</td>
                  <td>{row.asset}{row.network ? ` · ${row.network}` : ""}</td>
                  <td className="num">{row.amount}</td>
                  <td className="wrap">{row.address || row.reference || "—"}</td>
                  <td className="wrap">{row.txHash || "—"}</td>
                  <td>{row.status}{row.reason ? ` · ${row.reason}` : ""}</td>
                  <td>{row.actor || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
