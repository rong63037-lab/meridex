"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Shell } from "@/components/Shell";
import { api } from "@/lib/api";
import { tri } from "@/lib/tri";
import { useI18n } from "@/lib/i18n";

type Row = {
  id: number;
  email: string;
  fundId: string;
  name: string;
  frozen: boolean;
  internalTest: boolean;
  kycStatus: string;
  country: string;
};

function CustomersScreen() {
  const { lang } = useI18n();
  const params = useSearchParams();
  const t = (zh: string, en: string, ms: string) => tri(lang, zh, en, ms);
  const initial = params.get("q") ?? "";
  const [q, setQ] = useState(initial);
  const [query, setQuery] = useState(initial);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(q.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    setLoading(true);
    api<{ customers: Row[] }>(`/api/admin/customers?q=${encodeURIComponent(query)}`)
      .then((res) => setRows(res.customers))
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [query]);

  return (
    <Shell>
      <div className="page">
        <section className="panel">
          <div className="kicker">MERIDEX</div>
          <h1>{t("客户", "Customers", "Pelanggan")}</h1>
          <p className="hint">{t(
            "按邮箱、电话、姓名、资金账号或 UID 查找。",
            "Search by email, phone, name, fund ID, or UID.",
            "Cari dengan e-mel, telefon, nama, ID dana, atau UID.",
          )}</p>
          <input className="desk-input" value={q} placeholder={t("搜索", "Search", "Cari")} onChange={(e) => setQ(e.target.value)} />
          {error ? <p className="err" role="alert">{error}</p> : null}
          {loading ? <p className="hint">{t("正在加载…", "Loading…", "Memuatkan…")}</p> : null}
          {!loading && rows.length === 0 ? <p className="hint">{t("没有匹配的客户。", "No matching customer.", "Tiada pelanggan sepadan.")}</p> : null}
          {!loading && rows.length > 0 ? (
            <div className="scroll-table">
              <table>
                <thead>
                  <tr>
                    <th>{t("资金账号", "Fund ID", "ID dana")}</th>
                    <th>{t("客户", "Customer", "Pelanggan")}</th>
                    <th>KYC</th>
                    <th>{t("状态", "Status", "Status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td className="num"><Link href={`/customers/${row.id}`}>{row.fundId}</Link></td>
                      <td className="wrap">
                        <Link href={`/customers/${row.id}`}>{row.name || row.email}</Link>
                        <div className="hint">{row.email}{row.country ? ` · ${row.country}` : ""}</div>
                        {row.internalTest ? <span className="pill">{t("内部测试", "Internal test", "Ujian dalaman")}</span> : null}
                      </td>
                      <td>{row.kycStatus}</td>
                      <td>{row.frozen ? t("冻结", "Frozen", "Dibeku") : t("正常", "Active", "Aktif")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      </div>
    </Shell>
  );
}

export default function CustomersPage() {
  return (
    <Suspense fallback={<p className="hint">…</p>}>
      <CustomersScreen />
    </Suspense>
  );
}
