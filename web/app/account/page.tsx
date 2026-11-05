"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PortfolioHome } from "@/components/PortfolioHome";
import { Shell } from "@/components/Shell";
import { api } from "@/lib/api";
import { accountCopy, maskEmail } from "@/lib/account-copy";
import { useI18n } from "@/lib/i18n";
import { usePaperMode } from "@/lib/usePaper";
import { timeLabel } from "@/lib/format";

type Me = {
  id: number;
  email: string;
  role: string;
  entityId: string | null;
  jurisdiction: string | null;
  nationality?: string;
  residenceCountry?: string;
  kycStatus: string;
  kycReason?: string;
  vipDesk?: boolean;
  isInternalTest?: boolean;
};
type Growth = { tier: { id: string } | null };
type Login = { id: number; ip: string | null; country: string | null; created_at: string };
type SecInfo = { profile?: { frozen: boolean; phishing_code: string | null }; addresses?: unknown[] };

function say(lang: string, zh: string, en: string, ms: string) {
  return lang === "en" ? en : lang === "ms" ? ms : zh;
}

const entries = [
  { href: "/account/security", key: "security", hint: "securityHint" },
  { href: "/kyc", key: "kyc", hint: "kycHint" },
  { href: "/account/preferences", key: "prefs", hint: "prefsHint" },
  { href: "/account/referral", key: "referral", hint: "referralHint" },
  { href: "/account/api", key: "api", hint: "apiHint" },
  { href: "/support", key: "support", hint: "supportHint" },
] as const;

const more = [
  { href: "/portfolio", key: "orders", hint: "ordersHint" },
  { href: "/rewards", key: "rewards", hint: "rewardsHint" },
  { href: "/inbox", key: "inbox", hint: "inboxHint" },
  { href: "/developers", key: "developers", hint: "developersHint" },
  { href: "/help", key: "help", hint: "helpHint" },
] as const;

export default function AccountPage() {
  const { lang } = useI18n();
  const copy = accountCopy(lang);
  const { paper } = usePaperMode();
  const [me, setMe] = useState<Me | null>(null);
  const [tier, setTier] = useState("");
  const [copied, setCopied] = useState(false);
  const [logins, setLogins] = useState<Login[]>([]);
  const [sec, setSec] = useState<SecInfo | null>(null);

  useEffect(() => {
    api<Me>("/api/me").then(setMe).catch(() => undefined);
    api<Login[]>("/api/account/logins").then((rows) => setLogins(Array.isArray(rows) ? rows.slice(0, 5) : [])).catch(() => undefined);
    api<SecInfo>("/api/account/security").then(setSec).catch(() => undefined);
    api<Growth>("/api/growth").then((res) => setTier(res.tier?.id ?? "")).catch(() => undefined);
  }, []);

  const kyc = me?.kycStatus === "approved" ? copy.kycApproved : me?.kycStatus === "pending" ? copy.kycPending : me?.kycStatus === "rejected" ? copy.kycRejected : copy.kycNone;
  const kycClass = me?.kycStatus === "approved" ? "ok" : me?.kycStatus === "rejected" ? "bad" : "warn";
  const uid = me ? String(me.id) : "";
  // Security level is a display summary of settings the customer already has; it changes nothing.
  const checks = [
    { on: !me?.isInternalTest, key: "2fa" },
    { on: Boolean(sec?.profile?.phishing_code), key: "phish" },
    { on: (sec?.addresses?.length ?? 0) > 0, key: "whitelist" },
    { on: me?.kycStatus === "approved", key: "kyc" },
  ];
  const score = checks.filter((item) => item.on).length;
  const level = score >= 4 ? say(lang, "高", "High", "Tinggi") : score >= 2 ? say(lang, "中", "Medium", "Sederhana") : say(lang, "低", "Low", "Rendah");
  const cards = [
    { href: "/account/security", title: say(lang, "两步验证 (2FA)", "Two-factor (2FA)", "Dua faktor (2FA)"), state: me?.isInternalTest ? say(lang, "测试账户", "Test account", "Akaun ujian") : say(lang, "已开启", "On", "Hidup"), tone: me?.isInternalTest ? "warn" : "ok" },
    { href: "/account/security", title: say(lang, "登录密码", "Login password", "Kata laluan"), state: say(lang, "已设置", "Set", "Ditetapkan"), tone: "ok" },
    { href: "/kyc", title: say(lang, "实名认证", "Identity (KYC)", "Identiti (KYC)"), state: kyc, tone: kycClass },
    { href: "/account/security", title: say(lang, "防钓鱼码", "Anti-phishing code", "Kod anti-pancingan"), state: sec?.profile?.phishing_code ? say(lang, "已设置", "Set", "Ditetapkan") : say(lang, "未设置", "Not set", "Belum"), tone: sec?.profile?.phishing_code ? "ok" : "warn" },
  ];

  return (
    <Shell>
      <div className="page account-page" data-tour="account">
        <section className="panel profile-card">
          <span className="avatar-lg" aria-hidden>{me?.email.slice(0, 1).toUpperCase() ?? "·"}</span>
          <div className="profile-main">
            {me ? <p className="profile-mail">{maskEmail(me.email)}</p> : <div className="skeleton" style={{ height: 22, width: 180 }} />}
            <p className="hint">{copy.phone} · {copy.unbound}</p>
            <p className="uid-line">
              <span>{copy.uid}</span>
              <b className="num">{uid || "—"}</b>
              {uid ? (
                <button type="button" className="langbtn" onClick={() => { void navigator.clipboard.writeText(uid); setCopied(true); }}>
                  {copied ? copy.copied : copy.copy}
                </button>
              ) : null}
            </p>
          </div>
          <div className="profile-badges">
            <span className={`chip ${kycClass}`}>{kyc}</span>
            <span className="chip gold">{me?.vipDesk ? copy.vip : tier || copy.standard}</span>
          </div>
        </section>
        <section className="panel sec-level" aria-label="security level">
          <div className="sec-level-head">
            <span>{say(lang, "安全等级", "Security level", "Tahap keselamatan")}</span>
            <b className={`sec-${score >= 4 ? "hi" : score >= 2 ? "mid" : "lo"}`}>{level}</b>
          </div>
          <div className="sec-bar" aria-hidden>{checks.map((item) => <i key={item.key} className={item.on ? "on" : ""} />)}</div>
        </section>
        <div className="sec-cards">
          {cards.map((card) => (
            <Link key={card.title} href={card.href} className="sec-card">
              <span className="hint">{card.title}</span>
              <span className={`chip ${card.tone}`}>{card.state}</span>
            </Link>
          ))}
        </div>
        {logins.length ? (
          <section className="panel login-hist">
            <h2>{say(lang, "最近登录", "Recent sign-ins", "Log masuk terkini")}</h2>
            <table>
              <tbody>
                {logins.map((row) => (
                  <tr key={row.id}><td className="num">{timeLabel(row.created_at)}</td><td>{row.country ?? "—"}</td><td className="num">{row.ip ?? "—"}</td></tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
        <nav className="menu-list" aria-label={copy.security}>
          {entries.map((item) => (
            <Link key={item.href} href={item.href} className="menu-row">
              <span><b>{copy[item.key]}</b><span className="hint">{copy[item.hint]}</span></span>
              <span aria-hidden>›</span>
            </Link>
          ))}
        </nav>
        <p className="kicker">{copy.more}</p>
        <nav className="menu-list" aria-label={copy.more}>
          {more.map((item) => (
            <Link key={item.href} href={item.href} className="menu-row">
              <span><b>{copy[item.key]}</b><span className="hint">{copy[item.hint]}</span></span>
              <span aria-hidden>›</span>
            </Link>
          ))}
        </nav>
        {paper ? (
          <details className="panel sim-tools">
            <summary>{copy.demoDetails}</summary>
            <p className="hint">{copy.demoHint}</p>
            {me ? <p className="hint">{me.role} · {me.entityId ?? "—"} · {me.jurisdiction ?? "—"} · {me.residenceCountry ?? "—"} · {me.nationality ?? "—"}</p> : null}
            <PortfolioHome />
          </details>
        ) : null}
      </div>
    </Shell>
  );
}
