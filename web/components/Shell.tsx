"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useToast } from "@/components/Toast";
import { api } from "@/lib/api";
import { LangSelect, reasonText, useI18n } from "@/lib/i18n";
import { Tour } from "@/components/Tour";
import { usePaperMode } from "@/lib/usePaper";
import { Pwa } from "@/components/Pwa";
import { AccountSlot } from "@/components/AccountSlot";
import { deskCopy } from "@/lib/desk-copy";
import { liveAnnouncements } from "@/lib/live-copy";
import { useRouter } from "next/navigation";
import { ProIcon } from "@/components/ProIcons";
import { applySwap, proCopy, SWAP_KEY } from "@/lib/pro-copy";



const tabs = [
  { href: "/", key: "tabHome", icon: "home", center: false },
  { href: "/markets", key: "tabMarkets", icon: "markets", center: false },
  { href: "/terminal", key: "tabTrade", icon: "trade", center: true },
  { href: "/portfolio", key: "tabOrders", icon: "history", center: false },
  { href: "/funds", key: "tabAssets", icon: "wallet", center: false },
] as const;

// Everyday modes stay visible. Leverage, perps and copy trading are off by default,
// so they sit behind a "more" menu instead of crowding the switcher.
const modes = [
  { href: "/terminal", key: "modeSpot", simulated: false, more: false },
  { href: "/convert", key: "modeConvert", simulated: false, more: false },
  { href: "/recurring", key: "modeRecurring", simulated: false, more: false },
  { href: "/margin", key: "modeMargin", simulated: true, more: true },
  { href: "/perps", key: "modePerp", simulated: true, more: true },
  { href: "/copy", key: "modeCopy", simulated: true, more: true },
] as const;

export function Shell({ children }: { children: ReactNode }) {
  const { t, lang } = useI18n();
  const copy = deskCopy(lang);
  const { paper, setEnabled } = usePaperMode();
  const toast = useToast();
  const path = usePathname();
  const onTrade = modes.some((mode) => path === mode.href);
  const [email, setEmail] = useState("");
  const [internal, setInternal] = useState(false);
  const [country, setCountry] = useState("");
  const [bar, setBar] = useState(false);
  const pro = proCopy(lang);
  const router = useRouter();
  const [swap, setSwap] = useState(false);
  const [q, setQ] = useState("");

  useEffect(() => {
    const on = localStorage.getItem(SWAP_KEY) === "1";
    setSwap(on);
    applySwap(on);
  }, []);
  const liveBanner = liveAnnouncements().find((item) => item.banner);
  const banner = liveBanner ? `${liveBanner.title} · ${liveBanner.body}` : "";

  useEffect(() => {
    setBar(true);
    const id = window.setTimeout(() => setBar(false), 420);
    return () => window.clearTimeout(id);
  }, [path]);

  useEffect(() => {
    const seen = new Set<string>();
    const pull = () => {
      if (!localStorage.getItem("meridex.token")) return;
      api<{ notices: { id: string; symbol: string; direction: "above" | "below"; price: string; read: boolean }[] }>("/api/notices")
        .then((res) => {
          for (const notice of res.notices) {
            if (notice.read || seen.has(notice.id)) continue;
            seen.add(notice.id);
            const dir = notice.direction === "above" ? t.alertAbove : t.alertBelow;
            toast(`${t.priceAlert} ${notice.symbol} ${dir} ${notice.price}`, "ok");
          }
        })
        .catch(() => undefined);
    };
    pull();
    const id = window.setInterval(pull, 4000);
    return () => window.clearInterval(id);
  }, [t, toast]);

  useEffect(() => {
    const token = localStorage.getItem("meridex.token");
    if (!token) return;
    setCountry(localStorage.getItem("meridex.country") || "");
    fetch("/api/me", { headers: { authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((me) => {
        if (!me) return;
        setEmail(me.email);
        setInternal(Boolean(me.isInternalTest));
      })
      .catch(() => undefined);
  }, []);

  const inTrade = path === "/terminal" || path === "/convert" || path === "/recurring" || path === "/margin" || path === "/perps" || path === "/copy";
  const inAssets = path.startsWith("/funds") || path.startsWith("/portfolio");

  return (
    <div className="desk-body pro-ui">
      <div className="announce">{banner || t.announcements}</div>
      <div className={`route-bar ${bar ? "on" : ""}`} />
      <nav className="desk-nav pro-nav">
        <Link href="/" className="brand"><span className="mark" /> MERIDEX</Link>
        <div className="pro-menus">
          <details className="nav-more pro-menu" key={`b${path}`}>
            <summary>{pro.buyCrypto} ▾</summary>
            <div className="nav-more-pop">
              <Link href="/convert"><span><b>{pro.buyConvert}</b><small>{pro.buyConvertHint}</small></span></Link>
              <Link href="/recurring"><span><b>{pro.buyRecurring}</b><small>{pro.buyRecurringHint}</small></span></Link>
            </div>
          </details>
          <details className="nav-more pro-menu" key={`m${path}`}>
            <summary className={path.startsWith("/markets") || path.startsWith("/news") ? "active" : ""}>{pro.marketsMenu} ▾</summary>
            <div className="nav-more-pop">
              <Link href="/markets"><span><b>{pro.marketsAll}</b><small>{pro.marketsAllHint}</small></span></Link>
              <Link href="/news"><span><b>{lang === "en" ? "Market insights" : lang === "ms" ? "Maklumat pasaran" : "行情资讯"}</b><small>{lang === "en" ? "Movers, announcements, asset profiles" : lang === "ms" ? "Pergerakan, pengumuman, profil aset" : "涨跌榜、平台公告、币种简介"}</small></span></Link>
            </div>
          </details>
          <details className="nav-more pro-menu" key={`t${path}`}>
            <summary className={inTrade ? "active" : ""}>{pro.tradeMenu} ▾</summary>
            <div className="nav-more-pop">
              <Link href="/terminal"><span><b>{pro.tradeSpot}</b><small>{pro.tradeSpotHint}</small></span></Link>
              <Link href="/convert"><span><b>{t.modeConvert}</b><small>{pro.buyConvertHint}</small></span></Link>
              <Link href="/recurring"><span><b>{t.modeRecurring}</b><small>{pro.buyRecurringHint}</small></span></Link>
              <div className="pop-sep">{pro.tradeMore}</div>
              {modes.filter((mode) => mode.more).map((mode) => (
                <Link key={mode.href} href={mode.href}><span><b>{t[mode.key]}</b><small>{copy.offByDefault}</small></span></Link>
              ))}
            </div>
          </details>
          <Link href="/learn" className={path.startsWith("/learn") ? "active" : ""}>{lang === "en" ? "Learn" : lang === "ms" ? "Belajar" : "学习中心"}</Link>
          <details className="nav-more pro-menu" key={`a${path}`}>
            <summary className={inAssets ? "active" : ""}>{pro.assetsMenu} ▾</summary>
            <div className="nav-more-pop">
              <Link href="/funds"><span><b>{pro.assetsOverview}</b></span></Link>
              <Link href="/funds/deposit"><span><b>{pro.deposit}</b></span></Link>
              <Link href="/funds/withdraw"><span><b>{pro.withdraw}</b></span></Link>
              <Link href="/funds/history"><span><b>{pro.history}</b></span></Link>
              <Link href="/portfolio"><span><b>{pro.orders}</b></span></Link>
            </div>
          </details>
        </div>
        <div className="who">
          <form
            className="pro-search"
            role="search"
            onSubmit={(e) => { e.preventDefault(); router.push(`/markets${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`); }}
          >
            <ProIcon name="search" size={15} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={pro.search} aria-label={pro.search} />
          </form>
          <Link href="/funds" className="pro-assets-link">{pro.assetsMenu}</Link>
          {internal ? <span className="internal-badge">INTERNAL TEST / 内部测试</span> : null}
          {email && !internal ? (
            <button
              type="button"
              className={`paper-toggle ${paper ? "on" : ""}`}
              aria-pressed={paper}
              onClick={() => {
                void setEnabled(!paper).catch((err) => toast(reasonText(lang, (err as Error).message), "bad"));
              }}
            >
              {t.paperMode}
            </button>
          ) : null}
          <AccountSlot guest="login" />
          <LangSelect />
          <details className="nav-more settings-menu">
            <summary aria-label={copy.settings}>⚙</summary>
            <div className="nav-more-pop">
              <label className="nav-more-label">
                {pro.colorScheme}
                <select
                  className="desk-input"
                  style={{ width: "100%", padding: "4px 6px" }}
                  value={swap ? "red" : "green"}
                  onChange={(e) => {
                    const on = e.target.value === "red";
                    setSwap(on);
                    applySwap(on);
                    localStorage.setItem(SWAP_KEY, on ? "1" : "0");
                  }}
                >
                  <option value="green">{pro.greenUp}</option>
                  <option value="red">{pro.redUp}</option>
                </select>
              </label>
              <label className="nav-more-label">
                {copy.mockRegion}
                <select
                  className="desk-input"
                  style={{ width: "100%", padding: "4px 6px" }}
                  value={country}
                  aria-label={t.country}
                  onChange={(e) => {
                    setCountry(e.target.value);
                    if (e.target.value) localStorage.setItem("meridex.country", e.target.value);
                    else localStorage.removeItem("meridex.country");
                  }}
                >
                  <option value="">IP</option>
                  <option value="SG">SG</option>
                  <option value="US">US</option>
                  <option value="MY">MY</option>
                </select>
              </label>
            </div>
          </details>
        </div>
      </nav>
      {onTrade ? (
        <div className="mode-switch">
          {modes.filter((mode) => !mode.more).map((mode) => (
            <Link key={mode.href} href={mode.href} className={path === mode.href ? "active" : ""}>
              {t[mode.key]}
            </Link>
          ))}
          <details className="nav-more mode-more" key={path}>
            <summary className={modes.some((mode) => mode.more && path === mode.href) ? "active" : ""}>
              {modes.find((mode) => mode.more && path === mode.href) ? t[modes.find((mode) => mode.more && path === mode.href)!.key] : copy.moreModes} ▾
            </summary>
            <div className="nav-more-pop">
              {modes.filter((mode) => mode.more).map((mode) => (
                <Link key={mode.href} href={mode.href} className={path === mode.href ? "active" : ""}>
                  <span>{t[mode.key]}{mode.simulated && paper ? <em>{copy.simulated}</em> : null}</span>
                  <small>{copy.offByDefault}</small>
                </Link>
              ))}
            </div>
          </details>
        </div>
      ) : null}
      {children}
      <nav className="bottom-nav pro-tabbar" aria-label={t.trade}>
        {tabs.map((tab) => {
          const on = tab.href === "/" ? path === "/" : path === tab.href || path.startsWith(`${tab.href}/`) || (tab.href === "/terminal" && inTrade);
          return (
            <Link key={tab.href} href={tab.href} className={`${on ? "active" : ""}${tab.center ? " center" : ""}`}>
              <span className="tab-ico"><ProIcon name={tab.icon} size={tab.center ? 22 : 20} /></span>
              <span className="tab-label">{pro[tab.key]}</span>
            </Link>
          );
        })}
      </nav>
      <Pwa />
      <Tour />
    </div>
  );
}
