"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Shell } from "@/components/Shell";
import { baseOf } from "@/lib/coin-intro";
import { useI18n } from "@/lib/i18n";
import { pct, px, usdShort, useTickers, type MiniTicker } from "@/lib/market-tickers";

import NEWS from "@/lib/news-data.json";

// TODO(news-api): replace lib/news-data.json with a licensed market-news provider once a vendor
// contract is signed. Keep entries clearly attributed, never scrape or embed third-party news
// without permission, and keep platform announcements separate from third-party news.

type News = { id: string; sample: boolean; date: string; tag: string; title: string; body: string };

function Movers({ title, rows, lang }: { title: string; rows: MiniTicker[]; lang: string }) {
  return (
    <section className="panel news-movers">
      <h2>{title}</h2>
      <table>
        <tbody>
          {rows.map((r) => (
            <tr key={r.symbol}>
              <td><Link href={`/news/coin/${encodeURIComponent(baseOf(r.symbol))}`}><b>{r.symbol.endsWith("/USD") ? baseOf(r.symbol) : r.symbol}</b> <small className="hint">{lang === "zh" ? r.nameZh : r.nameEn}</small></Link></td>
              <td className="num r">{px(r)}</td>
              <td className={`num r ${r.change >= 0 ? "up" : "down"}`}>{pct(r.change)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default function NewsPage() {
  const { lang } = useI18n();
  const say = (zh: string, en: string, ms: string) => (lang === "en" ? en : lang === "ms" ? ms : zh);
  const { rows, ready } = useTickers();
  const live = rows.filter((r) => r.last > 0);
  const stats = useMemo(() => {
    const up = live.filter((r) => r.change > 0).length;
    const down = live.filter((r) => r.change < 0).length;
    const vol = live.reduce((s, r) => s + (r.venueVolumeUsd ?? 0), 0);
    const avg = live.length ? live.reduce((s, r) => s + r.change, 0) / live.length : 0;
    return { up, down, vol, avg };
  }, [live]);
  const gainers = [...live].sort((a, b) => b.change - a.change).slice(0, 6);
  const losers = [...live].sort((a, b) => a.change - b.change).slice(0, 6);
  const active = [...live].sort((a, b) => (b.venueVolumeUsd ?? 0) - (a.venueVolumeUsd ?? 0)).slice(0, 6);
  const coins = rows.filter((r) => (r.category === "crypto" || r.category === "metal") && r.symbol.endsWith("/USD"));

  return (
    <Shell>
      <div className="page news-page">
        <div className="news-head">
          <div>
            <h1>{say("行情资讯", "Market insights", "Maklumat pasaran")}</h1>
            <p className="hint">{say("行情数据来自本平台盘口与参考报价，仅供参考，不构成投资建议。", "Prices come from this platform's own book and reference quotes. For reference only, not investment advice.", "Harga dari buku platform ini. Rujukan sahaja.")}</p>
          </div>
          <Link href="/learn" className="news-learn">{say("新手？去学习中心", "New? Visit Learn", "Baharu? Pusat pembelajaran")} ›</Link>
        </div>

        <div className="news-stats">
          <div><span className="hint">{say("上线品种", "Listed", "Disenaraikan")}</span><b className="num">{ready ? rows.length : "—"}</b></div>
          <div><span className="hint">{say("上涨 / 下跌", "Up / down", "Naik / turun")}</span><b className="num"><span className="up">{stats.up}</span> / <span className="down">{stats.down}</span></b></div>
          <div><span className="hint">{say("平均 24h 涨跌", "Avg 24h change", "Purata 24j")}</span><b className={`num ${stats.avg >= 0 ? "up" : "down"}`}>{ready ? pct(stats.avg) : "—"}</b></div>
          <div><span className="hint">{say("本平台 24h 成交额", "Platform 24h volume", "Volum 24j platform")}</span><b className="num">{usdShort(stats.vol)}</b></div>
        </div>

        <div className="news-movers-grid">
          <Movers title={say("涨幅榜", "Top gainers", "Peningkatan tertinggi")} rows={gainers} lang={lang} />
          <Movers title={say("跌幅榜", "Top losers", "Penurunan tertinggi")} rows={losers} lang={lang} />
          <Movers title={say("成交额榜", "Most active", "Paling aktif")} rows={active} lang={lang} />
        </div>

        <div className="news-cols">
          <section className="panel news-feed">
            <h2>{say("平台公告", "Announcements", "Pengumuman")}</h2>
            {(NEWS as News[]).map((n) => (
              <article key={n.id} className="news-item">
                <div className="news-meta">
                  {n.sample ? <span className="news-sample">{say("示例公告", "Sample", "Contoh")}</span> : null}
                  <span className="news-tag">{n.tag}</span>
                  <span className="hint num">{n.date}</span>
                </div>
                <b>{n.title}</b>
                <p className="hint">{n.body}</p>
              </article>
            ))}
            <p className="hint news-todo">{say("第三方市场新闻将在接入持牌资讯服务后提供。", "Third-party market news will be added once a licensed news provider is connected.", "Berita pihak ketiga akan ditambah selepas penyedia berlesen disambungkan.")}</p>
          </section>
          <section className="panel news-coins">
            <h2>{say("币种与品种简介", "Asset profiles", "Profil aset")}</h2>
            <div className="news-coin-grid">
              {coins.map((r) => (
                <Link key={r.symbol} href={`/news/coin/${encodeURIComponent(baseOf(r.symbol))}`} className="news-coin">
                  <b>{baseOf(r.symbol)}</b>
                  <small className="hint">{lang === "zh" ? r.nameZh : r.nameEn}</small>
                  <span className={`num ${r.change >= 0 ? "up" : "down"}`}>{pct(r.change)}</span>
                </Link>
              ))}
            </div>
            <Link href="/markets" className="news-all">{say("查看全部行情", "All markets", "Semua pasaran")} ›</Link>
          </section>
        </div>
      </div>
    </Shell>
  );
}
