"use client";

import { useEffect, useState } from "react";
import { Shell } from "@/components/Shell";
import { api, authHeaders } from "@/lib/api";
import { formatUsd } from "@/lib/format";
import { tri } from "@/lib/tri";
import { useI18n } from "@/lib/i18n";

type Report = {
  dau: number;
  mau: number;
  funded: number;
  feeUusd: string;
  feeBps: number;
  byDay: { day: string; trades: number; volume_uusd: string }[];
  bySymbol: { symbol: string; trades: number; volume_uusd: string }[];
  byJurisdiction: { jurisdiction: string; volume_uusd: string }[];
  signups: { day: string; n: number }[];
};

export default function ReportsPage() {
  const { lang } = useI18n();
  const [data, setData] = useState<Report | null>(null);
  const [csv, setCsv] = useState("");

  useEffect(() => {
    api<Report>("/api/admin/ops/reports").then(setData).catch(() => undefined);
    fetch("/api/admin/ops/reports.csv", { headers: authHeaders(), credentials: "include" }).then((r) => r.text()).then(setCsv).catch(() => undefined);
  }, []);

  const max = Math.max(1, ...(data?.byDay.map((row) => Number(row.volume_uusd)) ?? [1]));

  return (
    <Shell>
      <div className="page">
        <section className="panel">
          <div className="kicker">{tri(lang, "运营报表", "Operations", "Operasi")}</div>
          <h1>{tri(lang, "经营报表", "Activity", "Aktiviti")}</h1>
          <div className="kpi">
            <article><span>DAU</span><b className="num">{data?.dau ?? "—"}</b></article>
            <article><span>MAU</span><b className="num">{data?.mau ?? "—"}</b></article>
            <article><span>{tri(lang, "有资金", "Funded", "Ada dana")}</span><b className="num">{data?.funded ?? "—"}</b></article>
            <article><span>{tri(lang, "费用计提", "Fee accrual", "Akruan yuran")}</span><b className="num">{data ? formatUsd(data.feeUusd) : "—"}</b></article>
          </div>
          <p className="hint">{tri(lang, "费用按成交名义金额和标准 taker 费率计提，另加闪兑手续费。这不是第二套账本。", "Fees are accrued for the report. They are not a second ledger.", "Yuran diakru untuk laporan. Ia bukan lejar kedua.")}</p>
        </section>
        <section className="panel">
          <h2>{tri(lang, "按日成交额", "Volume by day", "Volum mengikut hari")}</h2>
          <div className="bars">
            {(data?.byDay ?? []).map((row) => (
              <div key={row.day}>
                <span>{row.day.slice(5)}</span>
                <i style={{ width: `${(Number(row.volume_uusd) / max) * 100}%` }} />
                <b className="num">{row.trades}</b>
              </div>
            ))}
          </div>
        </section>
        <div className="split">
          <section className="panel">
            <h2>{tri(lang, "按合约", "By instrument", "Mengikut kontrak")}</h2>
            <table className="table">
              <tbody>
                {(data?.bySymbol ?? []).map((row) => (
                  <tr key={row.symbol}><td>{row.symbol}</td><td className="num">{formatUsd(row.volume_uusd)}</td></tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="panel">
            <h2>{tri(lang, "按居住地", "By residence", "Mengikut kediaman")}</h2>
            <table className="table">
              <tbody>
                {(data?.byJurisdiction ?? []).map((row) => (
                  <tr key={row.jurisdiction}><td>{row.jurisdiction}</td><td className="num">{formatUsd(row.volume_uusd)}</td></tr>
                ))}
              </tbody>
            </table>
            <h2>{tri(lang, "新开户", "Signups", "Pendaftaran baharu")}</h2>
            {(data?.signups ?? []).map((row) => <p key={row.day} className="hint">{row.day} · {row.n}</p>)}
          </section>
        </div>
        <section className="panel">
          <h2>CSV</h2>
          <pre className="hint" style={{ whiteSpace: "pre-wrap" }}>{csv.slice(0, 700)}</pre>
        </section>
      </div>
    </Shell>
  );
}
