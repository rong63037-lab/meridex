"use client";

import { useEffect, useState } from "react";
import { Shell } from "@/components/Shell";
import { api } from "@/lib/api";
import { conciergeCopy } from "@/lib/concierge-copy";
import { tri } from "@/lib/tri";
import { useI18n } from "@/lib/i18n";

type PoolRow = {
  id: number;
  asset: string;
  network: string;
  address: string;
  status: string;
  email: string | null;
};
type Stock = { asset: string; network: string; available: number; assigned: number; threshold: number; low: boolean };

export default function TreasuryPage() {
  const { lang } = useI18n();
  const copy = conciergeCopy(lang);
  const [rows, setRows] = useState<PoolRow[]>([]);
  const [stock, setStock] = useState<Stock[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ rows: PoolRow[]; stock: Stock[] }>("/api/admin/treasury/pool")
      .then((res) => { setRows(res.rows); setStock(res.stock); })
      .catch((err) => setError((err as Error).message));
  }, []);

  return (
    <Shell>
      <div className="page">
        <section className="panel">
          <div className="kicker">MERIDEX</div>
          <h1>{tri(lang, "充值地址池", "Address pool", "Kolam alamat")}</h1>
          <p className="hint">{copy.readOnly}</p>
          <p><a href="http://127.0.0.1:4319">{tri(lang, "打开地址后台", "Open the address desk", "Buka meja alamat")}</a></p>
          {error ? <p className="err">{error}</p> : null}
        </section>
        <section className="kpi">
          {stock.map((item) => (
            <article key={`${item.asset}-${item.network}`}>
              <span>{item.asset} {item.network}</span>
              <b className={item.low ? "down" : "num"}>{item.available}</b>
              <div className="hint">{tri(lang, "可用", "available", "tersedia")} / {item.threshold}{item.low ? " · LOW" : ""}</div>
            </article>
          ))}
        </section>
        <section className="panel table-wrap">
          {rows.length === 0 ? <p className="hint">{tri(lang, "还没有地址。", "No rows yet.", "Belum ada alamat.")}</p> : null}
          <table className="table">
            <thead><tr><th>id</th><th></th><th></th><th></th><th></th><th></th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="num">{row.id}</td>
                  <td>{row.asset}</td>
                  <td>{row.network}</td>
                  <td className="num">{row.address}</td>
                  <td>{row.status}</td>
                  <td>{row.email ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </Shell>
  );
}
