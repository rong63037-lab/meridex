"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AccountSlot } from "@/components/AccountSlot";
import { useI18n } from "@/lib/i18n";
import { tri } from "@/lib/tri";

const faqs = {
  zh: [
    ["这是真实交易所吗？", "不是。这是沙盒。没有真实资金、真实银行或真实交割。新加坡牌照申请进行中。"],
    ["为什么列出白银、铂金和钯金？", "它们各有独立订单簿。居住地和品类开关允许时可以下单，不只限于 XAU/USD。"],
    ["美元是不是把美国客户挡在外面？", "不是。美元是结算货币。美国居住地默认允许，和新加坡一样。"],
    ["止损和 OCO 在哪里撮合？", "触发前由网关记账并冻结资金。触发后才把限价单送进撮合引擎。"],
    ["手续费是多少？", "现货默认按基点收费，可在文案与参数里改。这里的余额不是真实资金。实物提取另扣模拟费用。"],
  ],
  en: [
    ["Is this a real exchange?", "No. It is a sandbox. There is no real money, bank, or delivery. The Singapore licence application is in progress."],
    ["Why are silver, platinum, and palladium listed?", "Each contract has its own order book. They can be ordered when the residence and category switches allow it, not only XAU/USD."],
    ["Does USD mean US customers are blocked?", "No. USD is the settlement currency. US residence is allowed by default, the same as Singapore."],
    ["Where do stop and OCO orders match?", "The gateway reserves funds until the trigger. Only then does a limit order reach the matching engine."],
    ["What is the fee?", "Spot trades use a basis-point fee by default. It can be changed under Content & parameters. Balances here are not real money. Physical redemption adds a simulated fee."],
  ],
  ms: [
    ["Adakah ini bursa sebenar?", "Tidak. Ini kotak pasir. Tiada wang sebenar, bank, atau serahan. Permohonan lesen Singapura sedang berjalan."],
    ["Mengapa perak, platinum, dan paladium disenaraikan?", "Ia sebut harga rujukan. Setiap kontrak ada buku sendiri. Kategori selain logam mungkin belum dibuka."],
    ["Adakah USD bermakna pelanggan AS disekat?", "Tidak. USD ialah mata wang penyelesaian. Kediaman AS dibenarkan secara lalai, sama seperti Singapura."],
    ["Di mana pesanan henti dan OCO dipadankan?", "Gerbang menempah dana sehingga pencetus. Selepas itu barulah pesanan had sampai ke enjin padanan."],
    ["Berapakah yuran?", "Dagangan spot guna yuran mata asas secara lalai. Ia boleh diubah di Kandungan & parameter. Baki di sini bukan wang sebenar. Penebusan fizikal ada yuran simulasi."],
  ],
} as const;

export default function HelpPage() {
  const { t, lang } = useI18n();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ id: string; title_zh: string; title_en: string; title_ms?: string | null; body_zh: string; body_en: string; body_ms?: string | null }[]>([]);
  useEffect(() => {
    const id = setTimeout(() => {
      fetch(`/api/help?q=${encodeURIComponent(q)}`).then((r) => r.json()).then((res) => setHits(res.articles ?? [])).catch(() => undefined);
    }, 200);
    return () => clearTimeout(id);
  }, [q]);
  return (
    <>
      <div className="announce">{t.announcements}</div>
      <header className="topnav"><Link href="/" className="brand"><span className="mark" /> MERIDEX</Link><AccountSlot /></header>
      <section className="section faq">
        <h2>{t.help}</h2>
        <p className="hint">{tri(lang, "搜索帮助", "Search help", "Cari bantuan")}</p>
        <input className="desk-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tri(lang, "搜索", "Search", "Cari")} />
        {hits.map((row) => (
          <details key={row.id} open>
            <summary>{tri(lang, row.title_zh, row.title_en, row.title_ms || row.title_en)}</summary>
            <p className="hint">{tri(lang, row.body_zh, row.body_en, row.body_ms || row.body_en)}</p>
          </details>
        ))}
        {faqs[lang].map(([q, a]) => (
          <details key={q} open><summary>{q}</summary><p className="hint">{a}</p></details>
        ))}
      </section>
    </>
  );
}
