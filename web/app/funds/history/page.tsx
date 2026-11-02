"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, authHeaders } from "@/lib/api";
import { fundsCopy } from "@/lib/funds-copy";
import { formatUsd, timeLabel } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { formatQtyWithUnit } from "@/lib/qty";

type Row = { id: number; kind: string; asset: string; amount: string; detail: string | null; created_at: string };
type Deposit = { id: string; asset: string; network: string | null; amount: string; status: string; txid: string | null; created_at: string };

export default function HistoryPage() {
  const { lang, t } = useI18n();
  const copy = fundsCopy(lang);
  const words = { gram: t.unitGram, kilogram: t.unitKg, ounce: t.unitOz };
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [asset, setAsset] = useState("");
  const [kind, setKind] = useState("");

  function load() {
    const q = new URLSearchParams();
    if (asset) q.set("asset", asset);
    if (kind) q.set("kind", kind);
    api<Row[]>(`/api/activity?${q.toString()}`).then(setRows).catch(() => router.push("/login"));
    api<{ deposits: Deposit[] }>("/api/wallet/deposits").then((res) => setDeposits(res.deposits ?? [])).catch(() => undefined);
  }
  useEffect(() => { load(); }, [asset, kind]);

  return (
    <>
      <section className="panel" id="deposits">
        <h1>{copy.deposits}</h1>
        {deposits.length === 0 ? <p className="hint">{copy.empty}</p> : (
          <ul className="recent-list">
            {deposits.map((row) => (
              <li key={row.id}>
                <span><b>{row.asset}</b> {row.network ?? ""} · <span className="num">{row.amount}</span>{row.txid ? <span className="hint"> · {row.txid.slice(0, 12)}…</span> : null}</span>
                <span className={`chip ${row.status === "credited" ? "ok" : row.status === "flagged" ? "bad" : "warn"}`}>{row.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="panel">
        <div className="section-head">
          <h2>{copy.activity}</h2>
          <button
            type="button"
            className="langbtn"
            onClick={() => {
              void fetch("/api/activity.csv", { headers: authHeaders() }).then(async (res) => {
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = url;
                link.download = "meridex-activity.csv";
                link.click();
                URL.revokeObjectURL(url);
              });
            }}
          >{copy.csv}</button>
        </div>
        <div className="filter-row">
          <select className="desk-input" value={asset} onChange={(e) => setAsset(e.target.value)} aria-label={copy.asset}>
            <option value="">{copy.all}</option>
            <option value="USD">USD</option>
            <option value="XAU">XAU</option>
            <option value="BTC">BTC</option>
          </select>
          <select className="desk-input" value={kind} onChange={(e) => setKind(e.target.value)} aria-label={copy.type}>
            <option value="">{copy.type}</option>
            <option value="deposit_usd">deposit_usd</option>
            <option value="withdraw_usd">withdraw_usd</option>
            <option value="vault_out">vault_out</option>
            <option value="trade_buy">trade_buy</option>
            <option value="trade_sell">trade_sell</option>
          </select>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>{copy.time}</th><th>{copy.type}</th><th>{copy.amount}</th><th></th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{timeLabel(row.created_at)}</td>
                  <td>{row.kind}</td>
                  <td className="num">{row.asset === "USD" ? formatUsd(row.amount) : formatQtyWithUnit(row.asset, row.amount, words)}</td>
                  <td>{row.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
