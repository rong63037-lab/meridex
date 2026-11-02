"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { LangSelect, useI18n } from "@/lib/i18n";

// Navigation is grouped so the top bar shows the daily jobs first and the rest sits in
// three dropdowns. Every page and route is unchanged; only how the links are laid out.
type NavKey = "desk" | "compliance" | "risk" | "ops" | "funds" | "liquidity" | "customers" | "reports" | "support" | "content" | "treasury" | "internal" | "security" | "outbox" | "kyc";
type NavLink = { href: string; key: NavKey };
type NavGroup = { group: "groupRisk" | "groupOps" | "groupSystem"; items: NavLink[] };

const nav: (NavLink | NavGroup)[] = [
  { href: "/", key: "desk" },
  { href: "/funds", key: "funds" },
  { href: "/customers", key: "customers" },
  { href: "/support", key: "support" },
  { group: "groupRisk", items: [
    { href: "/kyc", key: "kyc" },
    { href: "/compliance", key: "compliance" },
    { href: "/surveillance", key: "risk" },
    { href: "/security", key: "security" },
  ] },
  { group: "groupOps", items: [
    { href: "/ops", key: "ops" },
    { href: "/ops/reports", key: "reports" },
    { href: "/content", key: "content" },
    { href: "/liquidity", key: "liquidity" },
  ] },
  { group: "groupSystem", items: [
    { href: "/treasury", key: "treasury" },
    { href: "/outbox", key: "outbox" },
    { href: "/internal", key: "internal" },
  ] },
];

const labels = {
  zh: { kyc: "实名认证审核", desk: "首页 · 待办", compliance: "合规与辖区", risk: "交易巡检", ops: "运营变更", funds: "入金 / 出金", liquidity: "流动性", customers: "客户档案", reports: "数据报表", support: "客服坐席", content: "文案与参数", treasury: "充值地址（只读）", internal: "内部测试", security: "账号安全", outbox: "通知发件箱", logout: "退出", groupRisk: "合规风控", groupOps: "运营设置", groupSystem: "更多" },
  en: { kyc: "KYC review", desk: "Home · To do", compliance: "Compliance", risk: "Surveillance", ops: "Operations", funds: "Deposits / withdrawals", liquidity: "Liquidity", customers: "Customers", reports: "Reports", support: "Support desk", content: "Copy and params", treasury: "Addresses (read-only)", internal: "Internal test", security: "Security", outbox: "Outbox", logout: "Sign out", groupRisk: "Risk & compliance", groupOps: "Operations", groupSystem: "More" },
  ms: { kyc: "Semakan KYC", desk: "Utama · Tugasan", compliance: "Pematuhan", risk: "Pengawasan", ops: "Operasi", funds: "Deposit / pengeluaran", liquidity: "Kecairan", customers: "Pelanggan", reports: "Laporan", support: "Meja sokongan", content: "Teks dan parameter", treasury: "Alamat (baca sahaja)", internal: "Ujian dalaman", security: "Keselamatan", outbox: "Peti keluar", logout: "Log keluar", groupRisk: "Risiko & pematuhan", groupOps: "Operasi", groupSystem: "Lagi" },
} as const;

function isActive(path: string, href: string) {
  if (href === "/") return path === "/";
  if (href === "/ops") return path === "/ops";
  return path === href || path.startsWith(`${href}/`);
}

export function Shell({ children }: { children: ReactNode }) {
  const { lang } = useI18n();
  const path = usePathname();
  const router = useRouter();
  const copy = labels[lang];
  const [email, setEmail] = useState("");

  useEffect(() => {
    const token = localStorage.getItem("meridex.staff.token");
    if (!token) {
      router.replace("/login");
      return;
    }
    fetch("/api/admin/me", { headers: { authorization: `Bearer ${token}` }, credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((me) => {
        if (!me?.email) {
          localStorage.removeItem("meridex.staff.token");
          router.replace("/login");
          return;
        }
        setEmail(me.email);
      })
      .catch(() => undefined);
  }, [router]);

  const groupLabel = { groupRisk: copy.groupRisk, groupOps: copy.groupOps, groupSystem: copy.groupSystem } as const;

  return (
    <div className="desk-body admin-app pro-admin">
      <div className="admin-ribbon">MERIDEX ADMIN · INTERNAL · {copy.compliance}</div>
      <header className="desk-nav admin-nav">
        <Link href="/" className="brand"><span className="mark" /> MERIDEX <small className="admin-tag">ADMIN</small></Link>
        <div className="who">
          <span className="mail">{email}</span>
          <LangSelect />
          <button
            type="button"
            className="langbtn"
            onClick={() => {
              localStorage.removeItem("meridex.staff.token");
              void fetch("/api/admin/auth/logout", { method: "POST", credentials: "include" });
              router.push("/login");
            }}
          >
            {copy.logout}
          </button>
        </div>
      </header>
      <div className="admin-body">
        <aside className="admin-side" aria-label="Admin">
          {nav.map((entry) => "group" in entry ? (
            <div key={entry.group} className="side-group">
              <div className="side-title">{groupLabel[entry.group]}</div>
              {entry.items.map((item) => (
                <Link key={item.href} href={item.href} className={isActive(path, item.href) ? "active" : ""}>{copy[item.key]}</Link>
              ))}
            </div>
          ) : (
            <Link key={entry.href} href={entry.href} className={isActive(path, entry.href) ? "active" : ""}>{copy[entry.key]}</Link>
          ))}
        </aside>
        <div className="desk-main">{children}</div>
      </div>
    </div>
  );
}
