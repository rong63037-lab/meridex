"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { api, authHeaders } from "@/lib/api";
import { formatUsd } from "@/lib/format";
import { tri } from "@/lib/tri";
import { useI18n } from "@/lib/i18n";

type Row = {
  kind: "claim" | "credit";
  id: number;
  email: string;
  asset: string;
  network: string;
  amount: string;
  reference: string;
  status: string;
  at: string;
  matched: boolean;
};

const filters = ["today", "claims", "credits", "unmatched"] as const;

function formatHouseQty(symbol: string, raw: string): string {
  const base = symbol.split(/[/-]/)[0] || symbol;
  const metal = base === "XAU" || base === "XAG" || base === "XPT" || base === "XPD";
  const scale = metal ? 1000n : base === "BTC" || base === "ETH" ? 100_000_000n : 1n;
  const decimals = metal ? 3 : scale === 100_000_000n ? 8 : 0;
  const unit = metal ? "g" : base;
  let n: bigint;
  try { n = BigInt(raw); } catch { return raw; }
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / scale;
  const width = scale.toString().length - 1;
  const frac = decimals > 0 ? `.${(abs % scale).toString().padStart(width, "0").slice(0, decimals)}` : "";
  return `${neg ? "-" : ""}${whole.toString()}${frac} ${unit}`;
}

export default function ReconcilePage() {
  const { lang } = useI18n();
  const [filter, setFilter] = useState<(typeof filters)[number]>("today");
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState("");
  const [exposure, setExposure] = useState<{
    nets: { asset: string; symbol?: string; houseQty: string; customerQty: string }[];
    unrealizedHouseUusd: string;
    pnlOwedUusd: string;
    products: { product: string; enabled: boolean; openNotionalUusd: string; maxNotionalUusd: string }[];
  } | null>(null);
  const [exposureState, setExposureState] = useState<"loading" | "ready" | "error">("loading");

  const label = {
    today: tri(lang, "今天", "Today", "Hari ini"),
    claims: tri(lang, "申报", "Claims", "Tuntutan"),
    credits: tri(lang, "已入账", "Credits", "Kredit"),
    unmatched: tri(lang, "未匹配", "Unmatched", "Belum sepadan"),
  };

  function load(next: (typeof filters)[number]) {
    setFilter(next);
    api<{ rows: Row[] }>(`/api/admin/deposits/reconcile?filter=${next}`)
      .then((res) => setRows(res.rows))
      .catch((err) => setError((err as Error).message));
  }

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("filter");
    const next = filters.includes(q as (typeof filters)[number]) ? (q as (typeof filters)[number]) : "today";
    load(next);
    api<NonNullable<typeof exposure>>("/api/admin/live-exposure")
      .then((res) => { setExposure(res); setExposureState("ready"); })
      .catch(() => { setExposure(null); setExposureState("error"); });
  }, []);

  async function download() {
    const res = await fetch(`/api/admin/deposits/reconcile.csv?filter=${filter}`, { headers: authHeaders(), credentials: "include" });
    const text = await res.text();
    const blob = new Blob([text], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `reconcile-${filter}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Shell>
      <div className="page">
        <section className="panel">
          <div className="kicker">MERIDEX</div>
          <h1>{tri(lang, "入账对账", "Deposit reconciliation", "Penyelarasan deposit")}</h1>
          <p className="hint">{tri(
            lang,
            "今天的客户申报和手动入账放在一起。未匹配包含所有仍待核对的申报，以及今天没有对应申报的入账。",
            "Today's customer claims and manual credits sit together. Unmatched keeps every claim still waiting, plus today's credits that have no claim.",
            "Tuntutan pelanggan dan kredit manual hari ini disatukan. Belum sepadan menyimpan setiap tuntutan yang masih menunggu, dan kredit hari ini tanpa tuntutan.",
          )}</p>
          <p><Link href="/deposits">{tri(lang, "返回入账", "Back to credits", "Kembali ke kredit")}</Link></p>
          {error ? <p className="err">{error}</p> : null}
          <div className="btn-row">
            {filters.map((item) => (
              <Button key={item} type="button" size="sm" variant={filter === item ? "default" : "outline"} onClick={() => load(item)}>{label[item]}</Button>
            ))}
            <Button type="button" size="sm" variant="outline" onClick={() => void download()}>CSV</Button>
          </div>
        </section>
        <section className="panel">
          <h2>{tri(lang, "内部账本敞口", "House exposure", "Dedahan buku dalaman")}</h2>
          <p className="hint">{tri(lang, "客户净持仓的相反方向是本场所敞口。未支付盈利单列，不计入已入账现金。", "The house is the other side of customer net positions. Unpaid profit is listed apart from cash already posted.", "Buku adalah sisi lawan posisi bersih pelanggan. Untung belum bayar disenaraikan berasingan daripada tunai yang sudah dicatat.")}</p>
          {exposureState === "loading" ? <p className="hint">{tri(lang, "正在读取敞口…", "Loading exposure…", "Memuatkan dedahan…")}</p> : null}
          {exposureState === "error" ? <p className="err">{tri(lang, "敞口没有读到。刷新后再看。", "Exposure did not load. Refresh and try again.", "Dedahan tidak dimuatkan. Segar semula dan cuba lagi.")}</p> : null}
          {exposure ? (
            <>
              <p>{tri(lang, "应付未付盈亏", "PnL owed", "PnL terhutang")} <b className="num">{formatUsd(exposure.pnlOwedUusd)}</b></p>
              <p>{tri(lang, "未实现（本场所）", "Unrealised (house)", "Belum nyata (buku)")} <b className="num">{formatUsd(exposure.unrealizedHouseUusd)}</b></p>
              {exposure.products.map((item) => (
                <p key={item.product} className="hint">{item.product} {item.enabled ? "ON" : "OFF"} · {formatUsd(item.openNotionalUusd)} / {formatUsd(item.maxNotionalUusd)}</p>
              ))}
              {exposure.nets.length === 0 ? <p className="hint">{tri(lang, "没有未平仓位。", "No open exposure.", "Tiada dedahan terbuka.")}</p> : exposure.nets.map((net) => (
                <p key={net.asset}>{net.asset} · {tri(lang, "本场所", "house", "buku")} {formatHouseQty(net.symbol ?? net.asset, net.houseQty)} · {tri(lang, "客户", "customers", "pelanggan")} {formatHouseQty(net.symbol ?? net.asset, net.customerQty)}</p>
              ))}
            </>
          ) : null}
        </section>
        <section className="panel">
          {rows.length === 0 ? <p className="hint">{tri(lang, "这一栏是空的。", "Nothing in this filter.", "Tiada dalam penapis ini.")}</p> : null}
          {rows.map((row) => (
            <div key={`${row.kind}-${row.id}`} className="claim-row">
              <div>
                <b>{row.email}</b>
                <div className="hint">{row.kind === "claim" ? tri(lang, "申报", "Claim", "Tuntutan") : tri(lang, "入账", "Credit", "Kredit")} · {row.amount} {row.asset} · {row.reference}</div>
              </div>
              <span className="hint">{row.status}{row.matched ? "" : ` · ${tri(lang, "未匹配", "unmatched", "belum sepadan")}`}</span>
            </div>
          ))}
        </section>
      </div>
    </Shell>
  );
}
