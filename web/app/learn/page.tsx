"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Shell } from "@/components/Shell";
import { ProIcon } from "@/components/ProIcons";
import { ARTICLES, CATEGORIES, readingMinutes, type Category } from "@/lib/learn-content";
import { useI18n } from "@/lib/i18n";

export default function LearnPage() {
  const { lang } = useI18n();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<Category | "all">("all");
  const say = (zh: string, en: string, ms: string) => (lang === "en" ? en : lang === "ms" ? ms : zh);
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return ARTICLES.filter((a) => (cat === "all" || a.cat === cat) && (!term || `${a.title}${a.summary}${a.body.map((b) => `${b.h ?? ""}${b.p ?? ""}${(b.ul ?? []).join("")}`).join("")}`.toLowerCase().includes(term)));
  }, [q, cat]);
  const catName = (id: Category) => {
    const c = CATEGORIES.find((x) => x.id === id)!;
    return say(c.zh, c.en, c.ms);
  };

  return (
    <Shell>
      <div className="page learn-page">
        <section className="learn-hero">
          <div>
            <h1>{say("学习中心", "Learn", "Pusat pembelajaran")}</h1>
            <p className="hint">{say("从零开始了解加密资产、交易基础和账户安全。内容仅供教育参考，不构成投资建议。", "Crypto, trading basics and account safety from scratch. Education only, not investment advice.", "Asas kripto, dagangan dan keselamatan akaun. Pendidikan sahaja, bukan nasihat pelaburan.")}</p>
            {lang !== "zh" ? <p className="hint">{say("", "Articles are currently in Chinese.", "Artikel kini dalam bahasa Cina.")}</p> : null}
          </div>
          <div className="learn-search" role="search">
            <ProIcon name="search" size={15} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={say("搜索：限价单、2FA、诈骗…", "Search articles", "Cari artikel")} aria-label="search" />
          </div>
        </section>
        <div className="learn-cats" role="tablist">
          <button type="button" role="tab" aria-selected={cat === "all"} className={cat === "all" ? "on" : ""} onClick={() => setCat("all")}>{say("全部", "All", "Semua")} <span>{ARTICLES.length}</span></button>
          {CATEGORIES.map((c) => (
            <button key={c.id} type="button" role="tab" aria-selected={cat === c.id} className={cat === c.id ? "on" : ""} onClick={() => setCat(c.id)}>
              {say(c.zh, c.en, c.ms)} <span>{ARTICLES.filter((a) => a.cat === c.id).length}</span>
            </button>
          ))}
        </div>
        <div className="learn-grid">
          {shown.map((a) => (
            <Link key={a.slug} href={`/learn/${a.slug}`} className="learn-card">
              <span className="learn-tag">{catName(a.cat)}</span>
              <b>{a.title}</b>
              <p>{a.summary}</p>
              <small className="hint">{say(`约 ${readingMinutes(a)} 分钟阅读`, `${readingMinutes(a)} min read`, `${readingMinutes(a)} min bacaan`)}</small>
            </Link>
          ))}
          {shown.length === 0 ? <p className="hint">{say("没有找到相关文章", "No matching articles", "Tiada artikel")}</p> : null}
        </div>
        <section className="learn-sandbox">
          <div>
            <b>{say("用模拟交易练习", "Practise with paper trading", "Berlatih dengan dagangan simulasi")}</b>
            <p className="hint">{say("登录后点击右上角“模拟交易”即可使用虚拟资金练习下单。虚拟资金不会进入主账本，也不会出现在真实余额里。", "After signing in, switch on Paper trading at the top right. Virtual funds never touch the main ledger or your real balance.", "Selepas log masuk, hidupkan dagangan simulasi di kanan atas. Dana maya tidak menyentuh lejar utama.")}</p>
          </div>
          <Link href="/terminal" className="learn-cta">{say("去交易页", "Open trade page", "Buka halaman dagangan")} ›</Link>
        </section>
      </div>
    </Shell>
  );
}
