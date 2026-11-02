"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { AccountSlot } from "@/components/AccountSlot";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { formatPct, formatPx } from "@/lib/markets";
import { takeLookup, terminalHref } from "@/lib/symbol";

type Ticker = {
  symbol: string;
  nameZh: string;
  nameEn: string;
  category: string;
  last: number;
  change: number;
  priceScale: number;
  priceDecimals: number;
  regulatoryTag: string;
  feed: string;
  indicative: boolean;
};

export default function MarketPage() {
  const { t, lang } = useI18n();
  const params = useParams<{ symbol: string }>();
  const slug = typeof params.symbol === "string" ? params.symbol : "";
  const [row, setRow] = useState<Ticker | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    if (!slug) return;
    const mine = ++generation.current;
    api<Ticker[]>("/api/market/tickers").then((rows) => {
      const hit = takeLookup(mine, generation.current, slug, rows.map((item) => item.symbol));
      if (mine !== generation.current) return;
      setRow(rows.find((item) => item.symbol === hit) ?? null);
    }).catch(() => undefined);
  }, [slug]);
  const px = row ? row.last / row.priceScale : null;
  return (
    <>
      <div className="announce">{t.announcements}</div>
      <header className="topnav">
        <Link href="/" className="brand"><span className="mark" /> MERIDEX</Link>
        <AccountSlot />
      </header>
      <section className="section">
        <p className="kicker">{row?.category} · {t.demoBook}</p>
        <h1>{row?.symbol ?? slug.toUpperCase()}</h1>
        <p className="lede">{row ? (lang === "zh" ? row.nameZh : row.nameEn) : ""}</p>
        <p className="px">{formatPx(px, row?.priceDecimals)} <span className={row && row.change >= 0 ? "up" : "down"}>{formatPct(row?.change)}</span></p>
        <p className="hint">{row?.regulatoryTag}</p>
        <p className="hint">{t.indicativeNote} {t.sessionStats} · {row?.feed}</p>
        <Button asChild><Link href={row ? terminalHref(row.symbol) : "/terminal"}>{t.trade}</Link></Button>
      </section>
    </>
  );
}
