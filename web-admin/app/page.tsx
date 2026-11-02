"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Shell } from "@/components/Shell";
import { api } from "@/lib/api";
import { tri } from "@/lib/tri";
import { useI18n } from "@/lib/i18n";

type Todo = {
  claims: number;
  withdrawals: number;
  kyc: number;
  chats: number;
  feeds: number;
  feedOk: boolean;
  backup: { ok: boolean; status: "ok" | "failed" | "none"; at: string | null; file: string | null };
};

// Home tiles are grouped by job so staff can find a page in one click.
const groups = [
  {
    zh: "日常处理", en: "Daily work", ms: "Kerja harian",
    tiles: [
      { href: "/funds", zh: "入金 / 出金", en: "Deposits and withdrawals", ms: "Deposit dan pengeluaran", bodyZh: "上面是待办。每一笔仍要点确认并填写验证码。", bodyEn: "Queue at the top. Each item still needs a confirm and a code.", bodyMs: "Barisan di atas. Setiap item masih perlu pengesahan dan kod." },
      { href: "/customers", zh: "客户档案", en: "Customers", ms: "Pelanggan", bodyZh: "查找客户，看资料和 KYC 状态。", bodyEn: "Find a customer, profile and KYC status.", bodyMs: "Cari pelanggan, profil dan status KYC." },
      { href: "/support", zh: "客服坐席", en: "Support desk", ms: "Meja sokongan", bodyZh: "会话和工单。不会转给真人。", bodyEn: "Threads and tickets. Nothing is handed to a person.", bodyMs: "Sembang dan tiket. Tiada yang diserahkan kepada orang sebenar." },
    ],
  },
  {
    zh: "合规风控", en: "Risk and compliance", ms: "Risiko dan pematuhan",
    tiles: [
      { href: "/compliance", zh: "合规与辖区", en: "Compliance and jurisdictions", ms: "Pematuhan dan bidang kuasa", bodyZh: "客户、KYC、辖区开关、品类与模式、账本恒等式。", bodyEn: "Customers, KYC, jurisdiction switches, categories, modes, and ledger checks.", bodyMs: "Pelanggan, KYC, suis bidang kuasa, kategori, mod, dan semakan lejar." },
      { href: "/surveillance", zh: "交易巡检", en: "Surveillance", ms: "Pengawasan", bodyZh: "对倒、幌骗、大额和速度规则，案件与备注。", bodyEn: "Wash, spoofing, size and velocity rules, cases and notes.", bodyMs: "Peraturan padanan sendiri, spoofing, saiz dan kelajuan, kes dan nota." },
    ],
  },
  {
    zh: "运营设置", en: "Operations", ms: "Operasi",
    tiles: [
      { href: "/ops", zh: "运营变更", en: "Operations", ms: "Operasi", bodyZh: "客户冻结、费率、合约和公告。敏感变更要另一人复核。", bodyEn: "Freezes, fees, instruments, and announcements. Sensitive changes need a second operator.", bodyMs: "Pembekuan, yuran, kontrak, dan pengumuman. Perubahan sensitif perlukan operator kedua." },
      { href: "/ops/reports", zh: "数据报表", en: "Reports", ms: "Laporan", bodyZh: "DAU、MAU、入金用户、成交和手续费，可导出 CSV。", bodyEn: "DAU, MAU, funded users, volume, and fees, with CSV.", bodyMs: "DAU, MAU, pengguna berdana, volum, dan yuran, dengan CSV." },
      { href: "/content", zh: "文案与参数", en: "Copy and parameters", ms: "Teks dan parameter", bodyZh: "客户看到的文字和费率，几秒内生效。", bodyEn: "Customer-facing text and fees, live in seconds.", bodyMs: "Teks dan yuran pelanggan, berkuat kuasa dalam beberapa saat." },
      { href: "/outbox", zh: "通知发件箱", en: "Notification outbox", ms: "Peti keluar pemberitahuan", bodyZh: "邮件、短信和推送只写在本地模拟发件箱。", bodyEn: "Email, SMS, and push stay in the local mock outbox.", bodyMs: "E-mel, SMS, dan tolak kekal dalam peti keluar simulasi tempatan." },
    ],
  },
] as const;

export default function AdminHome() {
  const { lang } = useI18n();
  const [todo, setTodo] = useState<Todo | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<Todo>("/api/admin/todo").then(setTodo).catch((err) => setError((err as Error).message));
  }, []);

  const rows = [
    { href: "/funds?tab=deposits", label: tri(lang, "待入金", "Deposits waiting", "Deposit menunggu"), count: todo?.claims },
    { href: "/funds?tab=withdrawals", label: tri(lang, "待出金", "Withdrawals waiting", "Pengeluaran menunggu"), count: todo?.withdrawals },
    { href: "/compliance", label: tri(lang, "待审 KYC", "KYC waiting", "KYC menunggu"), count: todo?.kyc },
    { href: "/support", label: tri(lang, "未回复会话", "Unanswered chats", "Sembang belum dibalas"), count: todo?.chats },
    { href: "/#feeds", label: tri(lang, "行情异常", "Feed problems", "Masalah suapan"), count: todo?.feeds },
  ];

  const backup = todo?.backup;
  const backupText = !backup || backup.status === "none"
    ? tri(lang, "还没有备份", "No backup yet", "Belum ada sandaran")
    : backup.ok
      ? tri(lang, "备份成功", "Backup ok", "Sandaran berjaya")
      : tri(lang, "备份失败", "Backup failed", "Sandaran gagal");

  return (
    <Shell>
      <div className="page">
        <section className="panel">
          <div className="kicker">MERIDEX ADMIN</div>
          <h1>{tri(lang, "内部后台", "Internal console", "Konsol dalaman")}</h1>
          <p className="hint">{tri(
            lang,
            "这个后台和客户站点是两个应用。客户会话在网关会被拒绝。",
            "This desk is separate from the customer site. A customer session is rejected by the gateway.",
            "Meja ini berasingan daripada laman pelanggan. Sesi pelanggan ditolak di gerbang.",
          )}</p>
        </section>
        <div className="admin-home-grid">
        <section className="panel" id="todo">
          <h2>{tri(lang, "今日待办", "To do today", "Tugasan hari ini")}</h2>
          {error ? <p className="err">{error}</p> : null}
          {!todo && !error ? <p className="hint">{tri(lang, "正在加载…", "Loading…", "Memuatkan…")}</p> : null}
          <div className="kpi-grid">
            {rows.map((row) => (
              <Link key={row.href} href={row.href} className={`kpi-card${row.count ? " has" : ""}`}>
                <span>{row.label}</span>
                <b className="num">{row.count ?? "—"}</b>
              </Link>
            ))}
          </div>
          <div className="todo-list">
            <Link href="/#backup" id="backup">
              <span>{tri(lang, "最近备份", "Last backup", "Sandaran terakhir")}</span>
              <b>{backupText}{backup?.at ? ` · ${backup.at.replace("T", " ").slice(0, 16)}` : ""}</b>
            </Link>
          </div>
          <p className="hint" id="feeds">{todo?.feedOk
            ? tri(lang, "行情正常。", "Feeds are up.", "Suapan hidup.")
            : tri(lang, "行情有异常，看上面的计数。", "A feed reported a problem. The count is above.", "Suapan melaporkan masalah. Kiraan di atas.")}</p>
        </section>
        <div className="card-group-col">
          {groups.map((group) => (
            <section key={group.en} className="card-group">
              <h2>{tri(lang, group.zh, group.en, group.ms)}</h2>
              <div className="cards">
                {group.tiles.map((tile) => (
                  <Link key={tile.href} href={tile.href} className="card">
                    <h3>{tri(lang, tile.zh, tile.en, tile.ms)}</h3>
                    <p>{tri(lang, tile.bodyZh, tile.bodyEn, tile.bodyMs)}</p>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
        </div>
      </div>
    </Shell>
  );
}
