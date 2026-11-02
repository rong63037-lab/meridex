"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { fill, type PoolCopy } from "@/lib/copy";
import { parsePaste, type NetChoice } from "@/lib/paste";
import { useLang } from "@/lib/useLang";

type PoolRow = {
  id: number;
  asset: string;
  network: string;
  address: string;
  status: string;
  email: string | null;
};
type Stock = { asset: string; network: string; available: number; assigned: number; threshold: number; low: boolean };
type PreviewLine = { line: number; ok: boolean; reason: string | null };

const pairs = [
  { asset: "BTC", network: "Bitcoin" },
  { asset: "ETH", network: "Ethereum" },
  { asset: "USDT", network: "ERC20" },
  { asset: "USDT", network: "TRC20" },
];

function netName(t: PoolCopy, asset: string, network: string): string {
  if (asset === "BTC") return t.netBtc;
  if (asset === "ETH") return t.netEth;
  if (network === "TRC20") return t.netUsdtTron;
  if (asset === "USDT") return t.netUsdtEth;
  return `${asset} ${network}`;
}

function statusName(t: PoolCopy, status: string): string {
  if (status === "available") return t.statusFree;
  if (status === "assigned") return t.statusAssigned;
  if (status === "retired") return t.statusRetired;
  return status;
}

function explain(t: PoolCopy, code: string): string {
  if (code === "unknown" || code === "unknown network" || code === "missing address") return t.lineUnknown;
  if (code === "evm") return t.lineEvm;
  if (code === "mismatch") return t.lineMismatch;
  if (code === "bad bitcoin checksum") return t.lineBtc;
  if (code === "bad evm checksum") return t.lineEvmSum;
  if (code === "bad tron checksum") return t.lineTron;
  if (code === "duplicate") return t.lineDup;
  return t.lineGeneric;
}

function explainApi(t: PoolCopy, code: string): string {
  if (code === "INVALID_TOTP") return t.errTotp;
  if (code === "TOTP_REQUIRED") return t.errTotpNeed;
  if (code === "TOTP_LOCKED") return t.errLocked;
  if (code === "ADDRESS_IN_USE") return t.errInUse;
  if (code === "DUPLICATE_ADDRESS") return t.errDup;
  if (code === "VALIDATION") return t.errBad;
  if (code === "NOT_FOUND") return t.errMissing;
  return t.errGeneric;
}

export default function PoolDesk() {
  const router = useRouter();
  const { lang, setLang, t } = useLang();
  const [email, setEmail] = useState("");
  const [rows, setRows] = useState<PoolRow[]>([]);
  const [stock, setStock] = useState<Stock[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [paste, setPaste] = useState("");
  const [choice, setChoice] = useState<NetChoice>("auto");
  const [addTotp, setAddTotp] = useState("");
  const [preview, setPreview] = useState<PreviewLine[] | null>(null);
  const [previewKey, setPreviewKey] = useState("");
  const [checking, setChecking] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [replaceId, setReplaceId] = useState<number | null>(null);
  const [nextAddress, setNextAddress] = useState("");
  const [replaceTotp, setReplaceTotp] = useState("");
  const [removeId, setRemoveId] = useState<number | null>(null);
  const [removeTotp, setRemoveTotp] = useState("");
  const [thresholdTotp, setThresholdTotp] = useState("");
  const [csvTotp, setCsvTotp] = useState("");
  const [retireTotp, setRetireTotp] = useState("");
  const [assignTotp, setAssignTotp] = useState("");
  const [csv, setCsv] = useState("");
  const [thresholdPair, setThresholdPair] = useState("BTC|Bitcoin");
  const [threshold, setThreshold] = useState("2");
  const [retireId, setRetireId] = useState("");
  const [assignId, setAssignId] = useState("");
  const [assignEmail, setAssignEmail] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const drafts = useMemo(() => parsePaste(paste, choice), [paste, choice]);
  const draftKey = drafts.map((row) => `${row.line}|${row.asset}|${row.network}|${row.address}|${row.clientError ?? ""}`).join("\n");
  const clientProblems = drafts.filter((row) => row.clientError);
  const serverProblems = (preview ?? []).filter((row) => !row.ok);
  const problemCount = clientProblems.length + (previewKey === draftKey ? serverProblems.length : 0);
  const readyCount = drafts.filter((row) => {
    if (row.clientError) return false;
    if (previewKey !== draftKey) return false;
    return preview?.find((item) => item.line === row.line)?.ok === true;
  }).length;

  function load() {
    api<{ rows: PoolRow[]; stock: Stock[] }>("/api/pool/treasury/pool")
      .then((res) => {
        setRows(res.rows);
        setStock(res.stock);
        setLoaded(true);
      })
      .catch((err) => {
        const message = (err as Error).message;
        if (message === "MFA_REQUIRED" || message === "POOL_DESK" || message === "NOT_POOL_OWNER") {
          localStorage.removeItem("meridex.pool.token");
          router.replace("/login");
          return;
        }
        setError(explainApi(t, message));
        setLoaded(true);
      });
  }

  useEffect(() => {
    const token = localStorage.getItem("meridex.pool.token");
    if (!token) {
      router.replace("/login");
      return;
    }
    api<{ email: string }>("/api/pool/me")
      .then((me) => setEmail(me.email))
      .catch(() => {
        localStorage.removeItem("meridex.pool.token");
        router.replace("/login");
      });
    load();
  }, [router]);

  useEffect(() => {
    if (!email) return;
    const clean = drafts.filter((row) => !row.clientError);
    if (!clean.length) {
      setPreview([]);
      setPreviewKey(draftKey);
      setChecking(false);
      return;
    }
    let stale = false;
    setChecking(true);
    const handle = window.setTimeout(() => {
      api<{ lines: PreviewLine[] }>("/api/pool/treasury/pool/preview", {
        method: "POST",
        body: JSON.stringify({
          rows: clean.map((row) => ({ line: row.line, asset: row.asset, network: row.network, address: row.address })),
        }),
      })
        .then((res) => {
          if (stale) return;
          setPreview(res.lines);
          setPreviewKey(draftKey);
        })
        .catch((err) => {
          if (stale) return;
          const message = (err as Error).message;
          if (message === "MFA_REQUIRED" || message === "NOT_POOL_OWNER" || message === "POOL_DESK") {
            localStorage.removeItem("meridex.pool.token");
            router.replace("/login");
            return;
          }
          setPreview(null);
          setError(explainApi(t, message));
        })
        .finally(() => {
          if (!stale) setChecking(false);
        });
    }, 300);
    return () => {
      stale = true;
      window.clearTimeout(handle);
    };
  }, [draftKey, drafts, email, router, t]);

  async function write(path: string, body: Record<string, unknown>, ok: string) {
    setError("");
    setNote("");
    setBusy(true);
    try {
      const res = await api<{ accepted?: number; rejected?: { address: string; reason: string }[] }>(path, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (res.rejected?.length) {
        const extra = res.rejected.map((row) => `${row.address.slice(0, 10)}… ${explain(t, row.reason)}`).join(" ");
        setError(extra);
      }
      if (typeof res.accepted === "number") {
        if (res.accepted > 0) setNote(fill(t.saved, res.accepted));
      } else setNote(ok);
      load();
      return res;
    } catch (err) {
      setError(explainApi(t, (err as Error).message));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function savePaste() {
    const clean = drafts.filter((row) => !row.clientError);
    const res = await write(
      "/api/pool/treasury/pool/import",
      { totp: addTotp, rows: clean.map((row) => ({ asset: row.asset, network: row.network, address: row.address })) },
      fill(t.saved, clean.length),
    );
    if (!res) return;
    const rejected = new Set((res.rejected ?? []).map((row) => row.address.trim().toLowerCase()));
    if (!rejected.size && (res.accepted ?? 0) > 0) {
      setPaste("");
      setAddTotp("");
      setAdding(false);
    }
  }

  const low = stock.filter((item) => item.low);
  const shown = rows.filter((row) => {
    if (filter !== "all" && row.status !== filter) return false;
    const hay = `${row.address} ${row.email ?? ""} ${row.asset} ${row.network}`.toLowerCase();
    return hay.includes(query.trim().toLowerCase());
  });
  const canSave = !busy && !checking && problemCount === 0 && readyCount > 0 && /^\d{6}$/.test(addTotp) && previewKey === draftKey;

  return (
    <div className="desk-body admin-app">
      <div className="admin-ribbon">MERIDEX · {t.ribbon}{email ? ` · ${email}` : ""}</div>
      <nav className="desk-nav admin-nav">
        <span className="brand"><span className="mark" /> {t.title}</span>
        <div className="who">
          <select className="langbtn" aria-label="language" value={lang} onChange={(e) => setLang(e.target.value as "zh" | "en" | "ms")}>
            <option value="zh">中文</option>
            <option value="en">English</option>
            <option value="ms">Melayu</option>
          </select>
          <button
            type="button"
            className="langbtn"
            onClick={() => {
              localStorage.removeItem("meridex.pool.token");
              void fetch("/api/pool/auth/logout", { method: "POST" });
              router.push("/login");
            }}
          >
            {t.logout}
          </button>
        </div>
      </nav>
      <div className="desk-main">
        <div className="page desk-simple">
          <section className="desk-head">
            <div>
              <h1>{t.title}</h1>
              <p className="desk-help">{t.help}</p>
            </div>
            <Button type="button" size="lg" onClick={() => { setAdding((open) => !open); setError(""); }}>
              {adding ? t.close : t.add}
            </Button>
          </section>

          {note ? <p className="desk-banner ok" role="status">{note}</p> : null}
          {error ? <p className="desk-banner bad" role="alert">{error}</p> : null}

          <section className="kpi desk-summary">
            <article><span>{t.total}</span><b className="num">{rows.length}</b></article>
            <article><span>{t.free}</span><b className="num">{rows.filter((row) => row.status === "available").length}</b></article>
            <article><span>{t.assigned}</span><b className="num">{rows.filter((row) => row.status === "assigned").length}</b></article>
            <article>
              <span>{low.length ? t.lowBad : t.lowOk}</span>
              <b className={low.length ? "down" : "num"}>{low.length ? low.map((item) => netName(t, item.asset, item.network)).join(" · ") : "—"}</b>
            </article>
          </section>

          {adding ? (
            <section className="panel desk-add">
              <label htmlFor="net">{t.network}</label>
              <select id="net" className="desk-input" value={choice} onChange={(e) => setChoice(e.target.value as NetChoice)}>
                <option value="auto">{t.auto}</option>
                <option value="btc">{t.netBtc}</option>
                <option value="eth">{t.netEth}</option>
                <option value="usdt-erc20">{t.netUsdtEth}</option>
                <option value="usdt-trc20">{t.netUsdtTron}</option>
              </select>
              <label htmlFor="paste">{t.pasteLabel}</label>
              <textarea id="paste" className="desk-input" rows={6} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={t.pasteHint} />
              <p className="desk-count">
                {checking ? t.checking : problemCount ? fill(t.blocked, problemCount) : drafts.length ? fill(t.ready, readyCount) : t.pasteHint}
              </p>
              <ul className="line-errors">
                {drafts.map((row) => {
                  const server = previewKey === draftKey ? preview?.find((item) => item.line === row.line) : undefined;
                  const code = row.clientError || (server && !server.ok ? server.reason : null);
                  if (!code) return null;
                  return <li key={row.line}>{lang === "zh" ? `第 ${row.line} 行` : lang === "ms" ? `Baris ${row.line}` : `Line ${row.line}`}：{explain(t, code)}</li>;
                })}
              </ul>
              <label htmlFor="add-totp">{t.totp}</label>
              <input id="add-totp" className="desk-input totp" value={addTotp} onChange={(e) => setAddTotp(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" />
              <p className="hint">{t.totpHint}</p>
              <div className="desk-actions">
                <Button type="button" size="lg" disabled={!canSave} onClick={() => void savePaste()}>{t.save}</Button>
              </div>
            </section>
          ) : null}

          <section className="panel">
            <div className="desk-filters">
              <input className="desk-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.search} aria-label={t.search} />
              <select className="desk-input" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={t.filterAll}>
                <option value="all">{t.filterAll}</option>
                <option value="available">{t.filterFree}</option>
                <option value="assigned">{t.filterAssigned}</option>
                <option value="retired">{t.filterRetired}</option>
              </select>
            </div>
            {!loaded ? <p className="hint">{t.loading}</p> : null}
            {loaded && shown.length === 0 ? <p className="hint">{t.empty}</p> : null}
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t.colAddress}</th>
                    <th>{t.colNetwork}</th>
                    <th>{t.colStatus}</th>
                    <th>{t.colCustomer}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((row) => (
                    <tr key={row.id}>
                      <td className="addr">{row.address}</td>
                      <td>{netName(t, row.asset, row.network)}</td>
                      <td>{statusName(t, row.status)}</td>
                      <td>{row.email ?? t.none}</td>
                      <td className="row-actions">
                        {row.status === "assigned" ? (
                          <button type="button" className="langbtn" onClick={() => { setReplaceId(row.id); setRemoveId(null); setNextAddress(""); setReplaceTotp(""); setError(""); }}>{t.replace}</button>
                        ) : null}
                        {row.status === "available" ? (
                          <button type="button" className="langbtn" onClick={() => { setRemoveId(row.id); setReplaceId(null); setRemoveTotp(""); setError(""); }}>{t.remove}</button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {replaceId != null ? (
              <div className="desk-inline">
                <p className="hint">{rows.find((row) => row.id === replaceId)?.email}</p>
                <label>{t.newAddress}</label>
                <input className="desk-input" value={nextAddress} onChange={(e) => setNextAddress(e.target.value)} />
                <label>{t.totp}</label>
                <input className="desk-input totp" value={replaceTotp} onChange={(e) => setReplaceTotp(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" />
                <div className="desk-actions">
                  <Button type="button" disabled={busy || !nextAddress.trim() || !/^\d{6}$/.test(replaceTotp)} onClick={() => void write("/api/pool/treasury/pool/edit", { id: replaceId, address: nextAddress.trim(), totp: replaceTotp }, t.replaced).then((res) => { if (res) { setReplaceId(null); setReplaceTotp(""); setNextAddress(""); } })}>{t.save}</Button>
                  <button type="button" className="langbtn" onClick={() => setReplaceId(null)}>{t.cancel}</button>
                </div>
              </div>
            ) : null}
            {removeId != null ? (
              <div className="desk-inline">
                <p>{t.removeWarn}</p>
                <label>{t.totp}</label>
                <input className="desk-input totp" value={removeTotp} onChange={(e) => setRemoveTotp(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" />
                <div className="desk-actions">
                  <Button type="button" variant="danger" disabled={busy || !/^\d{6}$/.test(removeTotp)} onClick={() => void write("/api/pool/treasury/pool/delete", { id: removeId, totp: removeTotp }, t.removed).then((res) => { if (res) { setRemoveId(null); setRemoveTotp(""); } })}>{t.remove}</Button>
                  <button type="button" className="langbtn" onClick={() => setRemoveId(null)}>{t.cancel}</button>
                </div>
              </div>
            ) : null}
          </section>

          <details className="panel desk-more">
            <summary>{t.more}</summary>
            <p className="desk-help">{t.moreHelp}</p>
            <h2>{t.thresholdTitle}</h2>
            <p className="hint">{t.thresholdHint}</p>
            <div className="desk-filters">
              <select className="desk-input" value={thresholdPair} onChange={(e) => setThresholdPair(e.target.value)} aria-label={t.network}>
                {pairs.map((pair) => (
                  <option key={`${pair.asset}-${pair.network}`} value={`${pair.asset}|${pair.network}`}>{netName(t, pair.asset, pair.network)}</option>
                ))}
              </select>
              <input className="desk-input totp" value={threshold} onChange={(e) => setThreshold(e.target.value.replace(/\D/g, "").slice(0, 4))} inputMode="numeric" aria-label={t.thresholdTitle} />
              <input className="desk-input totp" value={thresholdTotp} onChange={(e) => setThresholdTotp(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" aria-label={t.totp} placeholder={t.totp} />
              <Button type="button" variant="outline" disabled={busy || !/^\d{6}$/.test(thresholdTotp)} onClick={() => {
                const [asset, network] = thresholdPair.split("|");
                void write("/api/pool/treasury/pool/threshold", { asset, network, threshold: Number(threshold), totp: thresholdTotp }, t.doneThreshold).then((res) => { if (res) setThresholdTotp(""); });
              }}>{t.save}</Button>
            </div>
            <h2>{t.csvTitle}</h2>
            <p className="hint">{t.csvHint}</p>
            <textarea className="desk-input" rows={4} value={csv} onChange={(e) => setCsv(e.target.value)} />
            <div className="desk-actions">
              <input className="desk-input totp" value={csvTotp} onChange={(e) => setCsvTotp(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" aria-label={t.totp} placeholder={t.totp} />
              <Button type="button" variant="outline" disabled={busy || !csv.trim() || !/^\d{6}$/.test(csvTotp)} onClick={() => void write("/api/pool/treasury/pool/import", { csv, totp: csvTotp }, t.doneCsv).then((res) => { if (res) { setCsv(""); setCsvTotp(""); } })}>{t.save}</Button>
            </div>
            <h2>{t.retireTitle}</h2>
            <p className="hint">{t.retireHint}</p>
            <div className="desk-filters">
              <select className="desk-input" value={retireId} onChange={(e) => setRetireId(e.target.value)} aria-label={t.pick}>
                <option value="">{t.pick}</option>
                {rows.filter((row) => row.status === "assigned").map((row) => (
                  <option key={row.id} value={row.id}>{netName(t, row.asset, row.network)} · {row.email}</option>
                ))}
              </select>
              <input className="desk-input totp" value={retireTotp} onChange={(e) => setRetireTotp(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" aria-label={t.totp} placeholder={t.totp} />
              <Button type="button" variant="outline" disabled={busy || !retireId || !/^\d{6}$/.test(retireTotp)} onClick={() => void write("/api/pool/treasury/pool/retire", { id: Number(retireId), totp: retireTotp }, t.doneRetire).then((res) => { if (res) { setRetireId(""); setRetireTotp(""); } })}>{t.save}</Button>
            </div>
            <h2>{t.assignTitle}</h2>
            <p className="hint">{t.assignHint}</p>
            <select className="desk-input" value={assignId} onChange={(e) => setAssignId(e.target.value)} aria-label={t.pick}>
              <option value="">{t.pick}</option>
              {rows.filter((row) => row.status === "available").map((row) => (
                <option key={row.id} value={row.id}>{netName(t, row.asset, row.network)} · {row.address.slice(0, 8)}…</option>
              ))}
            </select>
            <label>{t.email}</label>
            <input className="desk-input" value={assignEmail} onChange={(e) => setAssignEmail(e.target.value)} />
            <div className="desk-actions">
              <input className="desk-input totp" value={assignTotp} onChange={(e) => setAssignTotp(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" aria-label={t.totp} placeholder={t.totp} />
              <Button type="button" variant="outline" disabled={busy || !assignId || !assignEmail.includes("@") || !/^\d{6}$/.test(assignTotp)} onClick={() => void write("/api/pool/treasury/pool/assign", { id: Number(assignId), customerEmail: assignEmail.trim(), totp: assignTotp }, t.doneAssign).then((res) => { if (res) { setAssignId(""); setAssignEmail(""); setAssignTotp(""); } })}>{t.save}</Button>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
