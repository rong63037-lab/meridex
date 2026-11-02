"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Shell } from "@/components/Shell";
import { api } from "@/lib/api";
import { tri } from "@/lib/tri";
import { useI18n } from "@/lib/i18n";

// KYC review workspace. Lists customers by KYC status, opens the audited customer profile and
// sends 通过 / 驳回 to POST /api/admin/kyc/:id/decision (risk/compliance role + fresh TOTP;
// the gateway refuses self-review and only decides pending profiles).

type Row = { id: number; email: string; fundId: string; name: string; frozen: boolean; internalTest: boolean; kycStatus: string; country: string; createdAt: string };
type Detail = {
  customer: {
    id: number; fundId: string; email: string; name: string; phone: string; createdAt: string;
    kycStatus: string; kycTier: string; kycReason: string; country: string; nationality: string;
    riskFlags: string[]; status: string; internalTest: boolean; totpEnabled: boolean;
  };
};
type Filter = "pending" | "approved" | "rejected" | "none" | "all";

const FILTERS: Filter[] = ["pending", "approved", "rejected", "none", "all"];

export default function KycReviewPage() {
  const { lang } = useI18n();
  const t = (zh: string, en: string, ms: string) => tri(lang, zh, en, ms);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState<Filter>("pending");
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [reason, setReason] = useState("");
  const [totp, setTotp] = useState("");
  const [confirm, setConfirm] = useState<"approve" | "reject" | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(q.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    setLoading(true);
    api<{ customers: Row[] }>(`/api/admin/customers?q=${encodeURIComponent(query)}`)
      .then((res) => { setRows(res.customers); setError(""); })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [query, reload]);

  useEffect(() => {
    setConfirm(null); setReason(""); setTotp(""); setNote("");
    if (selected == null) { setDetail(null); return; }
    setDetail(null);
    api<Detail>(`/api/admin/customers/${selected}`).then(setDetail).catch((err) => setError((err as Error).message));
  }, [selected, reload]);

  async function decide(action: "approve" | "reject") {
    if (selected == null) return;
    setBusy(true);
    setNote("");
    try {
      await api(`/api/admin/kyc/${selected}/decision`, { method: "POST", body: JSON.stringify({ action, reason: reason.trim(), totp: totp.trim() }) });
      setNote(action === "approve" ? t("已通过", "Approved", "Diluluskan") : t("已驳回", "Rejected", "Ditolak"));
      setConfirm(null); setTotp("");
      setReload((n) => n + 1);
    } catch (err) {
      const code = (err as Error).message;
      const map: Record<string, string> = {
        SELF_REVIEW: t("不能审核自己或员工关联的账户", "You cannot review your own or a staff-linked account", "Tidak boleh menyemak akaun sendiri"),
        FORBIDDEN: t("只有风控 / 合规角色可以审核", "Only risk / compliance can review", "Hanya risiko / pematuhan"),
        NOT_PENDING: t("该申请已不是待审状态", "This application is no longer pending", "Tidak lagi menunggu"),
        REASON_REQUIRED: t("驳回必须填写原因", "A reject reason is required", "Sebab diperlukan"),
        TOTP_REQUIRED: t("请输入动态验证码", "Enter your 2FA code", "Masukkan kod 2FA"),
        INVALID_TOTP: t("动态验证码错误", "Wrong 2FA code", "Kod 2FA salah"),
        TOTP_LOCKED: t("验证码错误次数过多，已暂时锁定", "Too many wrong codes; locked for now", "Dikunci sementara"),
        JURISDICTION_NOT_OPEN: t("该居住地暂未开放，不能通过", "Residence not open yet; cannot approve", "Kediaman belum dibuka"),
      };
      setNote(map[code] ?? code);
    } finally {
      setBusy(false);
    }
  }

  const counts = useMemo(() => {
    const out: Record<Filter, number> = { pending: 0, approved: 0, rejected: 0, none: 0, all: rows.length };
    for (const row of rows) {
      const key = (["pending", "approved", "rejected"].includes(row.kycStatus) ? row.kycStatus : "none") as Filter;
      out[key] += 1;
    }
    return out;
  }, [rows]);
  const shown = rows.filter((row) => filter === "all" || (filter === "none" ? !["pending", "approved", "rejected"].includes(row.kycStatus) : row.kycStatus === filter));

  const label = (status: string) =>
    status === "pending" ? t("人工审核中", "In manual review", "Semakan manual")
    : status === "approved" ? t("已通过", "Approved", "Diluluskan")
    : status === "rejected" ? t("已驳回", "Rejected", "Ditolak")
    : status === "all" ? t("全部", "All", "Semua")
    : t("未提交", "Not submitted", "Belum dihantar");
  const tone = (status: string) => (status === "approved" ? "ok" : status === "pending" ? "warn" : status === "rejected" ? "bad" : "");
  const c = detail?.customer;

  return (
    <Shell>
      <div className="kyc-ws">
        <div className="kyc-ws-head">
          <div>
            <h1>{t("实名认证审核", "KYC review", "Semakan KYC")}</h1>
            <p className="hint">{t("每一份实名资料都必须由人工审核。通过 / 驳回需要风控或合规角色并输入动态验证码。", "Every KYC submission must be reviewed by a person. Approve / reject needs the risk or compliance role and a 2FA code.", "Setiap penghantaran KYC mesti disemak oleh manusia. Lulus / tolak memerlukan peranan risiko atau pematuhan dan kod 2FA.")}</p>
          </div>
        </div>
        <div className="kyc-ws-body">
          <aside className="kyc-queue panel">
            <input className="desk-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("搜索邮箱 / 资金编号 / UID", "Search email / fund ID / UID", "Cari e-mel / ID dana / UID")} aria-label="search" />
            <div className="kyc-filters" role="tablist">
              {FILTERS.map((key) => (
                <button key={key} type="button" role="tab" aria-selected={filter === key} className={filter === key ? "on" : ""} onClick={() => setFilter(key)}>
                  {label(key)} <span className="num">{counts[key]}</span>
                </button>
              ))}
            </div>
            {error ? <p className="err">{error}</p> : null}
            <div className="kyc-list">
              {loading ? <p className="hint">…</p> : null}
              {!loading && shown.length === 0 ? <p className="hint">{t("没有符合条件的申请", "No matching applications", "Tiada permohonan sepadan")}</p> : null}
              {shown.map((row) => (
                <button key={row.id} type="button" className={`kyc-item${selected === row.id ? " on" : ""}`} onClick={() => setSelected(row.id)}>
                  <span className="kyc-item-main">
                    <b>{row.name || row.email}</b>
                    <small className="hint">{row.fundId} · UID {row.id} · {row.country || "—"}</small>
                  </span>
                  <span className={`badge ${tone(row.kycStatus)}`}>{label(row.kycStatus)}</span>
                </button>
              ))}
            </div>
          </aside>
          <section className="kyc-detail panel">
            {!selected ? (
              <p className="hint kyc-empty">{t("从左侧队列选择一位客户", "Pick a customer from the queue", "Pilih pelanggan dari baris gilir")}</p>
            ) : !c ? (
              <div className="skeleton" style={{ height: 240 }} />
            ) : (
              <>
                <div className="kyc-detail-head">
                  <div>
                    <h2>{c.name || c.email}</h2>
                    <p className="hint">{c.email} · {c.fundId} · UID {c.id}</p>
                  </div>
                  <span className={`badge ${tone(c.kycStatus)}`}>{label(c.kycStatus)}</span>
                </div>
                <dl className="kyc-facts">
                  <div><dt>{t("国籍", "Nationality", "Kewarganegaraan")}</dt><dd>{c.nationality || "—"}</dd></div>
                  <div><dt>{t("居住地", "Residence", "Kediaman")}</dt><dd>{c.country || "—"}</dd></div>
                  <div><dt>{t("判定原因", "Reason", "Sebab")}</dt><dd>{c.kycReason || "—"}</dd></div>
                  <div><dt>{t("等级", "Tier", "Tahap")}</dt><dd>{c.kycTier || "—"}</dd></div>
                  <div><dt>{t("账户状态", "Account", "Akaun")}</dt><dd>{c.status}</dd></div>
                  <div><dt>2FA</dt><dd>{c.totpEnabled ? t("已开启", "On", "Hidup") : t("未开启", "Off", "Mati")}</dd></div>
                  <div><dt>{t("注册时间", "Registered", "Didaftar")}</dt><dd>{c.createdAt.slice(0, 10)}</dd></div>
                  <div><dt>{t("风险标记", "Risk flags", "Bendera risiko")}</dt><dd>{c.riskFlags.length ? c.riskFlags.join(", ") : "—"}</dd></div>
                </dl>
                <div className="kyc-docs">
                  {[t("证件正面", "ID front", "Depan ID"), t("证件反面", "ID back", "Belakang ID"), t("手持自拍", "Selfie", "Swafoto")].map((name) => (
                    <figure key={name} className="kyc-doc">
                      <div className="kyc-doc-img">{t("未上传", "Not uploaded", "Tiada")}</div>
                      <figcaption>{name}</figcaption>
                    </figure>
                  ))}
                </div>
                <p className="hint">{t("当前流程不收集证件图片，仅有国籍、居住地和制裁自述。", "The current flow collects no document images — only nationality, residence and a sanctions self-declaration.", "Aliran semasa tidak mengumpul imej dokumen.")}</p>
                <label className="hint" htmlFor="kyc-reason">{t("审核备注 / 驳回原因（驳回必填）", "Note / reject reason (required to reject)", "Nota / sebab penolakan")}</label>
                <textarea id="kyc-reason" className="desk-input" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} disabled={c.kycStatus !== "pending"} />
                {c.kycStatus !== "pending" ? <p className="hint">{t("只有“人工审核中”的申请可以通过或驳回。", "Only pending applications can be decided.", "Hanya permohonan menunggu boleh diputuskan.")}</p> : null}
                {confirm ? (
                  <div className={`kyc-confirm ${confirm}`}>
                    <b>{confirm === "approve" ? t("确认通过该客户的实名认证？", "Approve this customer's KYC?", "Luluskan KYC ini?") : t("确认驳回该客户的实名认证？", "Reject this customer's KYC?", "Tolak KYC ini?")}</b>
                    <span className="hint">{c.email} · UID {c.id}</span>
                    <input className="desk-input" inputMode="numeric" autoComplete="one-time-code" placeholder={t("你的动态验证码", "Your 2FA code", "Kod 2FA anda")} value={totp} onChange={(e) => setTotp(e.target.value)} />
                    <div className="kyc-actions">
                      <button type="button" className="kyc-cancel" onClick={() => setConfirm(null)} disabled={busy}>{t("取消", "Cancel", "Batal")}</button>
                      <button type="button" className={confirm === "approve" ? "kyc-approve" : "kyc-reject"} disabled={busy || !totp.trim() || (confirm === "reject" && reason.trim().length < 3)} onClick={() => decide(confirm)}>
                        {confirm === "approve" ? t("确认通过", "Confirm approve", "Sahkan lulus") : t("确认驳回", "Confirm reject", "Sahkan tolak")}
                      </button>
                    </div>
                  </div>
                ) : null}
                {note ? <p className="hint kyc-note">{note}</p> : null}
                <div className="kyc-actions">
                  <button type="button" className="kyc-reject" disabled={c.kycStatus !== "pending" || busy} onClick={() => setConfirm("reject")}>{t("驳回", "Reject", "Tolak")}</button>
                  <button type="button" className="kyc-approve" disabled={c.kycStatus !== "pending" || busy} onClick={() => setConfirm("approve")}>{t("通过", "Approve", "Lulus")}</button>
                  <Link href={`/customers/${c.id}`} className="kyc-open">{t("打开客户档案", "Open customer file", "Buka fail")} ›</Link>
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </Shell>
  );
}
