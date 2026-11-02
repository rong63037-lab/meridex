"use client";

import { useEffect, useState } from "react";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { timeLabel } from "@/lib/format";
import { tri } from "@/lib/tri";
import { useI18n } from "@/lib/i18n";

type UserRow = {
  id: number;
  email: string;
  role: string;
  entity_id: string | null;
  nationality: string | null;
  residence_country: string | null;
  sanctions_hit: boolean | null;
  kyc_status: string | null;
  kyc_reason: string | null;
};
type Alert = {
  id: number;
  email: string | null;
  ip_country: string | null;
  residence_country: string | null;
  action: string;
  detail: string | null;
  created_at: string;
};
type Check = { name: string; ok: boolean; detail: string };
type Access = "allow" | "pending" | "block";
type Rule = {
  country: string;
  access: Access;
  entity_id: string | null;
  region: string;
  nameZh: string;
  nameEn: string;
  nameMs: string;
  risk: "standard" | "edd" | "sanctioned";
  locked: boolean;
  noteZh: string | null;
  noteEn: string | null;
  noteMs: string | null;
};
type Audit = { id: number; country: string; previous_access: string | null; access: string; actor_email: string | null; created_at: string };
const REGIONS = ["east", "southeast", "south", "west", "central", "us"] as const;
const CATEGORIES = ["metal", "crypto", "commodity", "fx"] as const;
const MODES = ["convert", "recurring", "paper", "margin", "perp", "copy"] as const;

export default function AdminPage() {
  const { t, lang } = useI18n();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [filter, setFilter] = useState<"all" | "us">("all");
  const [rules, setRules] = useState<Rule[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [error, setError] = useState("");
  const [cats, setCats] = useState<{ category: string; country: string; access: Access }[]>([]);
  const [modes, setModes] = useState<{ mode: string; country: string; access: Access }[]>([]);
  const [modeAudit, setModeAudit] = useState<{ id: number; mode: string; country: string; previous_access: string | null; access: string; actor_email: string | null; created_at: string }[]>([]);
  const [usHard, setUsHard] = useState<string[]>(["margin", "perp"]);
  const [search, setSearch] = useState("");
  const [bulkRegion, setBulkRegion] = useState<(typeof REGIONS)[number]>("southeast");
  const [bulkField, setBulkField] = useState<string>("crypto");
  const [bulkAccess, setBulkAccess] = useState<Access>("block");
  const [notice, setNotice] = useState("");
  const [haltSymbol, setHaltSymbol] = useState("XAU/USD");
  const [poolAudit, setPoolAudit] = useState<{ id: number; action: string; actor: string | null; asset: string | null; network: string | null; old_hash: string | null; new_hash: string | null; detail: string | null; created_at: string }[]>([]);

  function load() {
    api<UserRow[]>("/api/admin/users").then(setUsers).catch((err) => setError((err as Error).message));
    api<Alert[]>("/api/admin/alerts").then(setAlerts).catch(() => undefined);
    api<{ checks: Check[] }>("/api/admin/invariants").then((res) => setChecks(res.checks)).catch(() => undefined);
    api<{ rules: { category: string; country: string; access: Access }[] }>("/api/admin/categories")
      .then((res) => setCats(res.rules))
      .catch(() => undefined);
    api<{ rules: { mode: string; country: string; access: Access }[]; audit: typeof modeAudit; usHard: string[] }>("/api/admin/modes")
      .then((res) => {
        setModes(res.rules);
        setModeAudit(res.audit);
        setUsHard(res.usHard ?? ["margin", "perp"]);
      })
      .catch(() => undefined);
    api<{ events: typeof poolAudit }>("/api/admin/treasury/audit").then((res) => setPoolAudit(res.events)).catch(() => undefined);
    api<{ rules: Rule[]; audit: Audit[] }>("/api/admin/jurisdictions")
      .then((res) => {
        setRules(res.rules);
        setAudit(res.audit);
      })
      .catch(() => undefined);
  }
  useEffect(() => { load(); }, []);

  const shown = users.filter((u) => {
    if (filter === "us") return u.residence_country === "US" || u.nationality === "US";
    return true;
  });
  const usCustomers = users.filter((u) => u.residence_country === "US" || u.nationality === "US").length;
  const accessLabel: Record<Access, string> = { allow: t.accessAllow, pending: t.accessPending, block: t.accessBlock };
  const regionLabel: Record<(typeof REGIONS)[number], string> = {
    east: t.regionEast,
    southeast: t.regionSoutheast,
    south: t.regionSouth,
    west: t.regionWest,
    central: t.regionCentral,
    us: t.regionUs,
  };
  const catLabel: Record<(typeof CATEGORIES)[number], string> = {
    metal: t.catMetal,
    crypto: t.catCrypto,
    commodity: t.catCommodity,
    fx: t.catFx,
  };
  const modeLabel: Record<(typeof MODES)[number], string> = {
    convert: t.modeConvert,
    recurring: t.modeRecurring,
    paper: t.paperMode,
    margin: t.modeMargin,
    perp: t.modePerp,
    copy: t.modeCopy,
  };
  function placeName(rule: Rule) {
    if (lang === "zh") return rule.nameZh;
    if (lang === "ms") return rule.nameMs;
    return rule.nameEn;
  }
  function placeNote(rule: Rule) {
    if (lang === "zh") return rule.noteZh;
    if (lang === "ms") return rule.noteMs;
    return rule.noteEn;
  }
  const query = search.trim().toLowerCase();
  const visible = rules.filter((rule) => {
    if (!query) return true;
    return rule.country.toLowerCase().includes(query) || placeName(rule).toLowerCase().includes(query);
  });
  function saveCell(url: string, body: Record<string, string>) {
    setError("");
    api(url, { method: "POST", body: JSON.stringify(body) }).then(load).catch((err) => setError((err as Error).message));
  }
  function proposeBulk() {
    setError("");
    setNotice("");
    api("/api/admin/ops/changes", {
      method: "POST",
      body: JSON.stringify({ kind: "jurisdiction_bulk", payload: { region: bulkRegion, field: bulkField, access: bulkAccess } }),
    }).then(() => setNotice(t.matrixPropose)).catch((err) => setError((err as Error).message));
  }

  const approved = users.filter((u) => u.kyc_status === "approved").length;
  const sanctions = users.filter((u) => u.sanctions_hit || u.kyc_reason === "SANCTIONS_HIT").length;
  const ledgerOk = checks.length > 0 && checks.every((c) => c.ok);
  const eddCountries = new Set(rules.filter((rule) => rule.risk === "edd").map((rule) => rule.country));

  function accessSelect(value: Access, disabled: boolean, onChange: (next: Access) => void) {
    return (
      <select className="desk-input" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as Access)}>
        <option value="allow">{t.accessAllow}</option>
        <option value="pending">{t.accessPending}</option>
        <option value="block">{t.accessBlock}</option>
      </select>
    );
  }

  return (
    <Shell>
      <div className="page">
        {error ? <p className="err">{error}</p> : null}
        {notice ? <p className="hint">{notice}</p> : null}
        <div className="kpi">
          <article><span>{t.kpiCustomers ?? t.users}</span><b className="num">{users.length}</b></article>
          <article><span>{t.kpiApproved ?? t.approved}</span><b className="num">{approved}</b></article>
          <article><span>{t.usOnly}</span><b className="num">{usCustomers}</b></article>
          <article><span>{t.kpiSanctions ?? t.sanctions}</span><b className="num">{sanctions}</b></article>
          <article><span>{t.alerts}</span><b className="num">{alerts.length}</b></article>
          <article><span>{t.invariants}</span><b className={ledgerOk ? "up" : "down"}>{checks.length ? (ledgerOk ? "OK" : "FAIL") : "—"}</b></article>
        </div>
        <div className="panel">
          <h2>{tri(lang, "地址池审计", "Address pool audit", "Audit kolam alamat")}</h2>
          <p className="hint">{tri(lang, "只追加。这里是地址哈希，不是地址原文。", "Append-only. Hashes only, not the address itself.", "Tambah sahaja. Di sini cuma hash, bukan alamat itu sendiri.")}</p>
          {poolAudit.length === 0 ? <p className="hint">—</p> : poolAudit.map((row) => (
            <p key={row.id} className="hint">{row.action} · {row.actor ?? "system"} · {row.asset} {row.network} · {row.old_hash?.slice(0, 10) ?? "—"} → {row.new_hash?.slice(0, 10) ?? "—"}</p>
          ))}
        </div>
        <div className="panel" style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <h2>{t.admin}</h2>
            <p className="hint">{t.usOnly}: {usCustomers} / {users.length}</p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Button size="sm" variant={filter === "all" ? "desk" : "outline"} onClick={() => setFilter("all")}>{t.all}</Button>
            <Button size="sm" variant={filter === "us" ? "desk" : "outline"} onClick={() => setFilter("us")}>{t.usOnly}</Button>
            <input className="desk-input" style={{ width: 140 }} aria-label="halt symbol" value={haltSymbol} onChange={(e) => setHaltSymbol(e.target.value.toUpperCase())} />
            <Button size="sm" variant="danger" onClick={() => api("/api/admin/halt", { method: "POST", body: JSON.stringify({ symbol: haltSymbol.trim() || "XAU/USD" }) }).then(load).catch((err) => setError((err as Error).message))}>{t.halt}</Button>
            <Button size="sm" variant="outline" onClick={() => api("/api/admin/resume", { method: "POST", body: JSON.stringify({ symbol: haltSymbol.trim() || "XAU/USD" }) }).then(load).catch((err) => setError((err as Error).message))}>{t.resume}</Button>
          </div>
        </div>
        <div className="panel" id="category-access">
          <h2>{t.jurisdictions}</h2>
          <p className="hint">{t.matrixHint}</p>
          <div className="chat-compose" style={{ marginBottom: 12 }}>
            <input className="desk-input" value={search} placeholder={t.matrixSearch} onChange={(e) => setSearch(e.target.value)} />
            <select className="desk-input" value={bulkRegion} onChange={(e) => setBulkRegion(e.target.value as (typeof REGIONS)[number])}>
              {REGIONS.map((id) => <option key={id} value={id}>{regionLabel[id]}</option>)}
            </select>
            <select className="desk-input" value={bulkField} onChange={(e) => setBulkField(e.target.value)}>
              <option value="residence">{t.fieldResidence}</option>
              {CATEGORIES.map((category) => <option key={category} value={category}>{catLabel[category]}</option>)}
              {MODES.map((mode) => <option key={mode} value={mode}>{modeLabel[mode]}</option>)}
            </select>
            <select className="desk-input" value={bulkAccess} onChange={(e) => setBulkAccess(e.target.value as Access)}>
              <option value="allow">{t.accessAllow}</option>
              <option value="pending">{t.accessPending}</option>
              <option value="block">{t.accessBlock}</option>
            </select>
            <Button size="sm" onClick={proposeBulk}>{t.matrixBulk}</Button>
          </div>
          {REGIONS.map((region) => {
            const rows = visible.filter((rule) => rule.region === region);
            if (!rows.length) return null;
            return (
              <section key={region} className="region-block">
                <h3>{regionLabel[region]}</h3>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th></th>
                        <th>{t.fieldResidence}</th>
                        {CATEGORIES.map((category) => <th key={category}>{catLabel[category]}</th>)}
                        {MODES.map((mode) => <th key={mode}>{modeLabel[mode]}</th>)}
                        <th>{t.entity}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((rule) => {
                        const hard = (mode: string) => rule.country === "US" && usHard.includes(mode);
                        return (
                          <tr key={rule.country}>
                            <td>
                              <b>{placeName(rule)}</b>
                              <div className="hint">{rule.country}{rule.risk === "edd" ? ` · ${t.riskEdd}` : ""}{rule.locked ? ` · ${t.riskSanction}` : ""}</div>
                              {placeNote(rule) ? <div className="hint">{placeNote(rule)}</div> : null}
                            </td>
                            <td>{accessSelect(rule.access, rule.locked, (access) => saveCell("/api/admin/jurisdictions", { country: rule.country, access }))}</td>
                            {CATEGORIES.map((category) => {
                              const cell = cats.find((row) => row.category === category && row.country === rule.country);
                              return (
                                <td key={category}>
                                  {accessSelect(cell?.access ?? "pending", rule.locked, (access) => saveCell("/api/admin/categories", { category, country: rule.country, access }))}
                                </td>
                              );
                            })}
                            {MODES.map((mode) => {
                              const cell = modes.find((row) => row.mode === mode && row.country === rule.country);
                              const lockedMode = rule.locked || (hard(mode) && (cell?.access ?? "block") !== "allow");
                              return (
                                <td key={mode}>
                                  <select
                                    className="desk-input"
                                    value={cell?.access ?? "block"}
                                    disabled={rule.locked}
                                    onChange={(e) => saveCell("/api/admin/modes", { mode, country: rule.country, access: e.target.value })}
                                  >
                                    <option value="allow" disabled={hard(mode)}>{t.accessAllow}</option>
                                    <option value="pending">{t.accessPending}</option>
                                    <option value="block">{t.accessBlock}</option>
                                  </select>
                                  {lockedMode && hard(mode) ? <div className="hint">US</div> : null}
                                </td>
                              );
                            })}
                            <td>{rule.entity_id ?? "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })}
          <h2 style={{ marginTop: 16 }}>{t.jurisdictionAudit}</h2>
          <table className="table">
            <thead><tr><th>{t.time}</th><th></th><th>{t.status}</th><th>{t.email}</th></tr></thead>
            <tbody>
              {audit.map((row) => (
                <tr key={row.id}>
                  <td>{timeLabel(row.created_at)}</td>
                  <td>{row.country}</td>
                  <td>{row.previous_access ? `${row.previous_access} → ` : ""}{accessLabel[row.access as Access] ?? row.access}</td>
                  <td>{row.actor_email ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2 style={{ marginTop: 16 }}>{t.modeAudit}</h2>
          <table className="table">
            <thead><tr><th>{t.time}</th><th></th><th>{t.status}</th><th>{t.email}</th></tr></thead>
            <tbody>
              {modeAudit.map((row) => (
                <tr key={row.id}>
                  <td>{timeLabel(row.created_at)}</td>
                  <td>{row.mode} · {row.country}</td>
                  <td>{row.previous_access ? `${row.previous_access} → ` : ""}{row.access}</td>
                  <td>{row.actor_email ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel">
          <h2>{t.invariants}</h2>
          {checks.map((check) => (
            <p key={check.name}><span className={`badge ${check.ok ? "ok" : "bad"}`}>{check.ok ? "OK" : "FAIL"}</span> {check.name}</p>
          ))}
        </div>
        <div className="panel">
          <h2>{t.users}</h2>
          <table className="table">
            <thead>
              <tr><th>{t.email}</th><th>{t.nationality}</th><th>{t.residence}</th><th>{t.status}</th><th>{t.reason}</th><th>{t.entity}</th></tr>
            </thead>
            <tbody>
              {shown.map((user) => (
                <tr key={user.id}>
                  <td>{user.email}<div className="hint">{user.role}</div></td>
                  <td>{user.nationality ?? "—"}</td>
                  <td>{user.residence_country ?? "—"}{eddCountries.has(user.residence_country ?? "") ? ` · ${t.riskEdd}` : ""}</td>
                  <td><span className={`badge ${user.kyc_status === "approved" ? "ok" : user.kyc_status === "pending" ? "warn" : "bad"}`}>{user.kyc_status ?? t.none}</span></td>
                  <td>{user.kyc_reason ?? "—"}{user.sanctions_hit ? " · sanctions" : ""}</td>
                  <td>{user.entity_id ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel">
          <h2>{t.alerts}</h2>
          <table className="table">
            <thead><tr><th>{t.time}</th><th>{t.email}</th><th>IP</th><th>{t.residence}</th><th>{t.status}</th><th></th></tr></thead>
            <tbody>
              {alerts.map((alert) => (
                <tr key={alert.id}>
                  <td>{timeLabel(alert.created_at)}</td>
                  <td>{alert.email}</td>
                  <td>{alert.ip_country}</td>
                  <td>{alert.residence_country}</td>
                  <td><span className={`badge ${alert.action === "block" ? "bad" : "warn"}`}>{alert.action}</span></td>
                  <td>{alert.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Shell>
  );
}
