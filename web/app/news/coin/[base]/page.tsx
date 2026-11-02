"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Shell } from "@/components/Shell";
import { INTROS, baseOf, genericIntro } from "@/lib/coin-intro";
import { useI18n } from "@/lib/i18n";
import { pct, px, usdShort, useTickers } from "@/lib/market-tickers";
import { terminalHref } from "@/lib/symbol";

export default function CoinPage() {
  const { lang } = useI18n();
  const say = (zh: string, en: string, ms: string) => (lang === "en" ? en : lang === "ms" ? ms : zh);
  const params = useParams<{ base: string }>();
  const base = decodeURIComponent(params.base || "").toUpperCase();
  const { rows, ready } = useTickers();
  const pairs = rows.filter((r) => baseOf(r.symbol) === base);
  const main = pairs.find((r) => r.symbol.endsWith("/USD")) ?? pairs[0];
  const name = main ? (lang === "zh" ? main.nameZh : main.nameEn) : base;
  const intro = INTROS[base] ?? genericIntro(name, main?.category ?? "");

  if (ready && !main) {
    return (
      <Shell>
        <div className="page coin-page"><p className="hint">{say("本平台暂未上线该品种", "Not listed on this platform", "Tidak disenaraikan")}</p><Link href="/news">‹ {say("返回行情资讯", "Back", "Kembali")}</Link></div>
      </Shell>
    );
  }
  return (
    <Shell>
      <div className="page coin-page">
        <nav className="learn-crumbs"><Link href="/news">{say("行情资讯", "Market insights", "Maklumat pasaran")}</Link> › <span>{base}</span></nav>
        <section className="coin-head panel">
          <div className="coin-title">
            <span className="coin-badge">{base.slice(0, 1)}</span>
            <div><h1>{base} <small className="hint">{name}</small></h1><p className="hint">{intro.kind}{intro.launched ? ` · ${say("诞生于", "Since", "Sejak")} ${intro.launched}` : ""}</p></div>
          </div>
          {main ? (
            <div className="coin-px">
              <b className="num">{px(main)}</b>
              <span className={`num ${main.change >= 0 ? "up" : "down"}`}>{pct(main.change)}</span>
              <small className="hint">{main.symbol} · {say("本平台 24h 成交额", "24h volume", "Volum 24j")} {usdShort(main.venueVolumeUsd)}</small>
            </div>
          ) : <div className="skeleton" style={{ height: 48, width: 160 }} />}
          {main ? <Link href={terminalHref(main.symbol)} className="coin-trade">{say("去交易", "Trade", "Dagang")}</Link> : null}
        </section>
        <section className="panel coin-body">
          <h2>{say("简介", "About", "Perihal")}</h2>
          {intro.body.map((p) => <p key={p}>{p}</p>)}
          {lang !== "zh" ? <p className="hint">{say("", "Profile text is currently in Chinese.", "Profil kini dalam bahasa Cina.")}</p> : null}
          <p className="learn-warn">⚠ {intro.risks ?? say("价格波动可能很大，过往表现不代表未来结果。", "Prices can be very volatile; past performance does not indicate future results.", "Harga boleh sangat tidak menentu.")}</p>
          <p className="hint">{say("本页内容仅供参考，不构成投资建议。", "For reference only; not investment advice.", "Rujukan sahaja; bukan nasihat pelaburan.")} <Link href="/learn/risk-disclosure">{say("阅读风险披露", "Read the risk disclosure", "Baca pendedahan risiko")}</Link></p>
        </section>
      </div>
    </Shell>
  );
}
