"use client";

import { useEffect, useMemo, useState } from "react";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { tri } from "@/lib/tri";
import { reasonText, useI18n } from "@/lib/i18n";

type StringRow = { key: string; lang: string; value: string; default: string; overridden: boolean };
type NumberRow = { key: string; value: number; min: number; max: number; def: number; integer: boolean; label: string };
type Announcement = { id: string; title: string; body: string; banner: boolean; active: boolean };
type Payload = { strings: StringRow[]; numbers: NumberRow[]; announcements: Announcement[] };

export default function ContentPage() {
  const { lang } = useI18n();
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [picked, setPicked] = useState<StringRow | null>(null);
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<"strings" | "numbers" | "banners">("strings");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [banner, setBanner] = useState(true);
  const [editId, setEditId] = useState("");

  function load() {
    api<Payload>("/api/admin/content")
      .then((res) => {
        setData(res);
        setError("");
      })
      .catch((err) => setError((err as Error).message));
  }
  useEffect(() => { load(); }, []);

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.strings ?? []).filter((row) => {
      if (filter !== "all" && row.lang !== filter && !row.key.includes(`.${filter}.`) && !row.key.startsWith(`${filter}.`)) return false;
      if (!needle) return row.overridden;
      return row.key.toLowerCase().includes(needle) || row.value.toLowerCase().includes(needle) || row.default.toLowerCase().includes(needle);
    }).slice(0, 80);
  }, [data, q, filter]);

  async function saveString() {
    if (!picked) return;
    setError("");
    setNote("");
    try {
      await api("/api/admin/content/string", { method: "PUT", body: JSON.stringify({ key: picked.key, value: draft }) });
      setNote(tri(lang, "已保存。客户站点几秒内会用上这条。", "Saved. The customer site picks this up within a few seconds.", "Disimpan. Laman pelanggan guna dalam beberapa saat."));
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function resetString() {
    if (!picked) return;
    setError("");
    try {
      const res = await api<{ value: string }>("/api/admin/content/string", { method: "DELETE", body: JSON.stringify({ key: picked.key }) });
      setDraft(res.value);
      setNote(tri(lang, "已恢复成安装包里的默认文案。", "Reset to the bundled default.", "Dipulihkan ke lalai pakej."));
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function saveNumber(row: NumberRow, raw: string, totp?: string) {
    setError("");
    setNote("");
    const value = Number(raw);
    if (!Number.isFinite(value) || (row.integer && !Number.isInteger(value)) || value < row.min || value > row.max) {
      setError(tri(lang, `超出范围 ${row.min}–${row.max}`, `Out of range ${row.min}–${row.max}`, `Di luar julat ${row.min}–${row.max}`));
      return;
    }
    try {
      await api("/api/admin/content/number", { method: "PUT", body: JSON.stringify({ key: row.key, value, totp }) });
      setNote(tri(lang, "已保存。", "Saved.", "Disimpan."));
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function resetNumber(key: string) {
    setError("");
    try {
      await api("/api/admin/content/number", { method: "DELETE", body: JSON.stringify({ key }) });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function saveBanner(active = true) {
    setError("");
    try {
      await api("/api/admin/content/announcement", {
        method: "POST",
        body: JSON.stringify({ id: editId || undefined, title, body, banner, active }),
      });
      setTitle("");
      setBody("");
      setEditId("");
      setNote(tri(lang, "公告已保存。", "Announcement saved.", "Pengumuman disimpan."));
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Shell>
      <div className="page">
        <section className="panel">
          <div className="kicker">MERIDEX</div>
          <h1>{tri(lang, "文案与参数", "Content & parameters", "Kandungan & parameter")}</h1>
          <p className="hint">
            {tri(lang,
              "文案覆盖写在数据库里，盖在安装包自带的中文、英文和马来文上面。数字会校验范围，每次修改都记下旧值和新值。充值地址不在这里改。",
              "Overrides sit in the database on top of the bundled zh / en / ms copy. Numbers are checked against a range and each change keeps the old and new value. Deposit addresses are not here.",
              "Tindihan disimpan dalam pangkalan data di atas salinan zh / en / ms. Nombor disemak mengikut julat, dan setiap perubahan menyimpan nilai lama dan baharu. Alamat deposit tidak di sini.",
            )}
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button type="button" variant={tab === "strings" ? "default" : "outline"} onClick={() => setTab("strings")}>{tri(lang, "文案", "Copy", "Salinan")}</Button>
            <Button type="button" variant={tab === "numbers" ? "default" : "outline"} onClick={() => setTab("numbers")}>{tri(lang, "数字", "Numbers", "Nombor")}</Button>
            <Button type="button" variant={tab === "banners" ? "default" : "outline"} onClick={() => setTab("banners")}>{tri(lang, "公告", "Banners", "Sepanduk")}</Button>
          </div>
          {error ? <p className="err">{error}</p> : null}
          {note ? <p className="hint">{note}</p> : null}
          {!data ? <p className="hint">{tri(lang, "正在加载…", "Loading…", "Memuatkan…")}</p> : null}
        </section>
        <LiveSwitches />
        <ReferenceSwitch />

        {tab === "strings" && data ? (
          <section className="panel">
            <div className="chat-compose">
              <input className="desk-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tri(lang, "搜索键或文案", "Search key or text", "Cari kunci atau teks")} />
              <select className="desk-input" value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="all">{tri(lang, "全部语言", "All languages", "Semua bahasa")}</option>
                <option value="zh">中文</option>
                <option value="en">English</option>
                <option value="ms">Melayu</option>
              </select>
            </div>
            <p className="hint">{q.trim() ? matches.length : `${matches.length} overridden`} / {data.strings.length}</p>
            <div className="split">
              <div className="table-wrap" style={{ maxHeight: 420, overflow: "auto" }}>
                <table className="table">
                  <tbody>
                    {matches.map((row) => (
                      <tr key={row.key} onClick={() => { setPicked(row); setDraft(row.value); }} style={{ cursor: "pointer" }}>
                        <td><b>{row.key}</b><div className="hint">{row.overridden ? tri(lang, "已覆盖", "override", "tindihan") : tri(lang, "默认", "default", "lalai")}</div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {matches.length === 0 ? <p className="hint">{tri(lang, "没有匹配。可以搜 heroTitle 这类键。", "Nothing matches. Search a key such as heroTitle.", "Tiada padanan. Cari kunci seperti heroTitle.")}</p> : null}
              </div>
              <div>
                {picked ? (
                  <>
                    <h2>{picked.key}</h2>
                    <p className="hint">{tri(lang, "默认", "Default", "Lalai")}: {picked.default}</p>
                    <textarea className="desk-input" rows={5} value={draft} onChange={(e) => setDraft(e.target.value)} />
                    <p className="hint">{tri(lang, "预览", "Preview", "Pratonton")}</p>
                    <div className="panel"><p>{draft || "—"}</p></div>
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                      <Button type="button" onClick={() => void saveString()}>{tri(lang, "保存", "Save", "Simpan")}</Button>
                      <Button type="button" variant="outline" onClick={() => void resetString()}>{tri(lang, "恢复默认", "Reset", "Pulihkan")}</Button>
                    </div>
                  </>
                ) : <p className="hint">{tri(lang, "选一个键。不搜索时只列出已覆盖的文案。", "Pick a key. An empty search lists overrides only.", "Pilih satu kunci. Carian kosong hanya menyenaraikan tindihan.")}</p>}
              </div>
            </div>
          </section>
        ) : null}

        {tab === "numbers" && data ? (
          <>
            <FeeTable rows={data.numbers.filter((row) => row.key.startsWith("fee."))} onSave={saveNumber} />
            <section className="panel table-wrap">
              <table className="table">
                <tbody>
                  {data.numbers.filter((row) => !row.key.startsWith("fee.")).map((row) => (
                    <NumberEditor key={row.key} row={row} onSave={saveNumber} onReset={resetNumber} />
                  ))}
                </tbody>
              </table>
            </section>
          </>
        ) : null}

        {tab === "banners" && data ? (
          <section className="panel">
            <h2>{editId ? editId : tri(lang, "新公告", "New announcement", "Pengumuman baharu")}</h2>
            <label>{tri(lang, "标题", "Title", "Tajuk")}</label>
            <input className="desk-input" value={title} onChange={(e) => setTitle(e.target.value)} />
            <label>{tri(lang, "正文", "Body", "Isi")}</label>
            <textarea className="desk-input" rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
            <label><input type="checkbox" checked={banner} onChange={(e) => setBanner(e.target.checked)} /> {tri(lang, "作为顶部横幅", "Show as the top banner", "Tunjuk sebagai sepanduk atas")}</label>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <Button type="button" onClick={() => void saveBanner(true)}>{tri(lang, "保存", "Save", "Simpan")}</Button>
              {editId ? <Button type="button" variant="outline" onClick={() => void saveBanner(false)}>{tri(lang, "停用", "Hide", "Sembunyi")}</Button> : null}
            </div>
            <p className="hint">{tri(lang, "预览", "Preview", "Pratonton")}: {banner && title ? `${title} · ${body}` : tri(lang, "不会作为横幅。", "Not a banner.", "Bukan sepanduk.")}</p>
            {(data.announcements ?? []).map((row) => (
              <p key={row.id}>
                <button
                  type="button"
                  className="langbtn"
                  onClick={() => { setEditId(row.id); setTitle(row.title); setBody(row.body); setBanner(row.banner); }}
                >
                  {row.banner ? "banner" : "note"} · {row.active ? "on" : "off"} · {row.title}
                </button>
              </p>
            ))}
          </section>
        ) : null}
      </div>
    </Shell>
  );
}

function FeeTable({
  rows,
  onSave,
}: {
  rows: NumberRow[];
  onSave: (row: NumberRow, raw: string, totp?: string) => Promise<void>;
}) {
  const { lang } = useI18n();
  const [totp, setTotp] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  useEffect(() => {
    const next: Record<string, string> = {};
    for (const row of rows) next[row.key] = String(row.value);
    setDrafts(next);
  }, [rows]);
  const groups = [
    { title: tri(lang, "现货", "Spot", "Semerta"), keys: rows.filter((row) => !row.key.startsWith("fee.perp")) },
    { title: tri(lang, "永续", "Perpetual", "Kekal"), keys: rows.filter((row) => row.key.startsWith("fee.perp")) },
  ];
  return (
    <section className="panel">
      <h2>{tri(lang, "费率", "Fee rates", "Kadar yuran")}</h2>
      <p className="hint">{tri(
        lang,
        "单位是基点，1 基点 = 0.01%。改费率要所有者的 6 位动态验证码，并写入审计。只影响之后的新成交。",
        "Unit is basis points. 1 bp = 0.01%. Changing a rate needs the owner's 6-digit authenticator code and is written to the audit log. Only later fills use the new rate.",
        "Unit ialah mata asas. 1 bp = 0.01%. Menukar kadar perlukan kod pengesah 6 digit pemilik dan dicatat dalam audit. Hanya isian kemudian guna kadar baharu.",
      )}</p>
      <label>{tri(lang, "验证码", "Authenticator", "Kod pengesah")}
        <input className="desk-input" value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} />
      </label>
      {groups.map((group) => (
        <div key={group.title} className="table-wrap" style={{ marginTop: 12 }}>
          <h3>{group.title}</h3>
          <table className="table">
            <tbody>
              {group.keys.map((row) => (
                <tr key={row.key}>
                  <td>
                    <b>{row.label}</b>
                    <div className="hint">{row.key}</div>
                  </td>
                  <td>
                    <input
                      className="desk-input"
                      value={drafts[row.key] ?? String(row.value)}
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [row.key]: e.target.value }))}
                      inputMode="decimal"
                    />
                  </td>
                  <td>
                    <button type="button" className="langbtn" onClick={() => void onSave(row, drafts[row.key] ?? String(row.value), totp)}>
                      {tri(lang, "保存", "Save", "Simpan")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}

function NumberEditor({
  row,
  onSave,
  onReset,
}: {
  row: NumberRow;
  onSave: (row: NumberRow, raw: string) => Promise<void>;
  onReset: (key: string) => Promise<void>;
}) {
  const [raw, setRaw] = useState(String(row.value));
  useEffect(() => setRaw(String(row.value)), [row.value]);
  return (
    <tr>
      <td>
        <b>{row.label}</b>
        <div className="hint">{row.key} · {row.min}–{row.max} · default {row.def}</div>
      </td>
      <td><input className="desk-input" value={raw} onChange={(e) => setRaw(e.target.value)} inputMode="decimal" /></td>
      <td>
        <button type="button" className="langbtn" onClick={() => void onSave(row, raw)}>Save</button>
        <button type="button" className="langbtn" onClick={() => void onReset(row.key)}>Reset</button>
      </td>
    </tr>
  );
}

type LiveRow = { product: string; enabled: boolean; maxNotionalUsd: string; maxLeverage: string };

function usdToInput(uusd: string): string {
  const n = BigInt(uusd);
  const dollars = n / 1_000_000n;
  const cents = (n / 10_000n) % 100n;
  return `${dollars}.${cents.toString().padStart(2, "0")}`;
}

function ReferenceSwitch() {
  const { lang } = useI18n();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [audit, setAudit] = useState("");
  const [totp, setTotp] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function load() {
    api<{ enabled: boolean; audit: { actor_email?: string; created_at?: string; next?: { enabled?: boolean } }[] }>("/api/admin/reference-depth")
      .then((res) => {
        setEnabled(res.enabled);
        const last = res.audit?.[0];
        setAudit(last ? `${last.actor_email ?? ""} · ${last.created_at ?? ""}` : "");
        setError("");
      })
      .catch((err) => setError((err as Error).message));
  }
  useEffect(() => { load(); }, []);

  async function save() {
    setNote("");
    if (enabled === null) return;
    if (!/^\d{6}$/.test(totp.trim())) {
      setError("TOTP_REQUIRED");
      return;
    }
    setError("");
    setBusy(true);
    try {
      const res = await api<{ enabled: boolean; audit: { actor_email?: string; created_at?: string }[] }>("/api/admin/reference-depth", {
        method: "POST",
        body: JSON.stringify({ enabled, totp: totp.trim() }),
      });
      setEnabled(res.enabled);
      const last = res.audit?.[0];
      setAudit(last ? `${last.actor_email ?? ""} · ${last.created_at ?? ""}` : "");
      setTotp("");
      setNote(tri(lang, "已记下，并写入审计。", "Saved and written to the audit log.", "Disimpan dan dicatat dalam audit."));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error === "FORBIDDEN") return null;
  return (
    <section className="panel">
      <h2>{tri(lang, "参考行情", "Reference market", "Pasaran rujukan")}</h2>
      <p className="hint">{tri(
        lang,
        "默认关闭。打开后，客户在现货和合约页看到公开交易所的买卖盘，并写明这不是本平台的流动性。只读，不需要密钥，也不会向外发送订单。行情超过 4 秒会标成过时。每次保存都要所有者的 6 位动态验证码，并写入审计。",
        "Off by default. On shows a public exchange book on the spot and perps pages, labelled as not this platform's liquidity. Read only, no key, and no order is sent. A quote older than 4 seconds is marked stale. Each save needs the owner's 6-digit authenticator code and writes an audit row.",
        "Tutup secara lalai. Buka menunjukkan buku bursa awam di halaman spot dan perpetual, dilabel bukan kecairan platform ini. Baca sahaja, tiada kunci, dan tiada pesanan dihantar. Sebut harga lebih 4 saat ditanda lapuk. Setiap simpan perlukan kod pengesah 6 digit pemilik dan menulis audit.",
      )}</p>
      {enabled === null && !error ? <p className="hint">{tri(lang, "正在读取开关…", "Loading the switch…", "Memuatkan suis…")}</p> : null}
      {error && error !== "FORBIDDEN" ? <p className="err" role="alert">{reasonText(lang, error)}</p> : null}
      {note ? <p className="hint">{note}</p> : null}
      {audit ? <p className="hint">{tri(lang, "最近审计", "Latest audit", "Audit terkini")}: {audit}</p> : null}
      <label>{tri(lang, "验证码", "Authenticator", "Kod pengesah")}
        <input className="desk-input" value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} />
      </label>
      <div className="btn-row">
        <Button type="button" variant={enabled ? "default" : "outline"} onClick={() => setEnabled(true)}>ON</Button>
        <Button type="button" variant={enabled === false ? "default" : "outline"} onClick={() => setEnabled(false)}>OFF</Button>
        <Button type="button" disabled={busy || enabled === null} onClick={() => void save()}>{busy ? tri(lang, "正在保存…", "Saving…", "Menyimpan…") : tri(lang, "保存", "Save", "Simpan")}</Button>
      </div>
    </section>
  );
}

function LiveSwitches() {
  const { lang } = useI18n();
  const [rows, setRows] = useState<LiveRow[] | null>(null);
  const [totp, setTotp] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const names: Record<string, string> = {
    margin: tri(lang, "杠杆", "Margin", "Margin"),
    perp: tri(lang, "合约", "Perps", "Perpetual"),
    copy: tri(lang, "跟单", "Copy", "Salin"),
  };

  function load() {
    api<{ products: { product: string; enabled: boolean; maxNotionalUusd: string; maxLeverage: number }[] }>("/api/admin/live-products")
      .then((res) => {
        setRows(res.products.map((row) => ({ product: row.product, enabled: row.enabled, maxNotionalUsd: usdToInput(row.maxNotionalUusd), maxLeverage: String(row.maxLeverage) })));
        setError("");
      })
      .catch((err) => setError((err as Error).message));
  }
  useEffect(() => { load(); }, []);

  async function save(row: LiveRow) {
    setNote("");
    if (!/^\d{6}$/.test(totp.trim())) {
      setError("TOTP_REQUIRED");
      return;
    }
    const range = tri(
      lang,
      "名义上限是 1 到 1,000,000 美元，最多两位小数。杠杆是 2 到 10 的整数。",
      "Notional cap is 1 to 1,000,000 USD with at most two decimals. Leverage is an integer from 2 to 10.",
      "Had nilai ialah 1 hingga 1,000,000 USD dengan paling banyak dua perpuluhan. Leveraj ialah integer 2 hingga 10.",
    );
    if (!/^\d+(\.\d{1,2})?$/.test(row.maxNotionalUsd.trim())) {
      setError(range);
      return;
    }
    const notional = Number(row.maxNotionalUsd);
    const leverage = Number(row.maxLeverage);
    if (!Number.isInteger(leverage) || leverage < 2 || leverage > 10 || notional < 1 || notional > 1_000_000) {
      setError(range);
      return;
    }
    setError("");
    setBusy(row.product);
    try {
      const res = await api<{ products: { product: string; enabled: boolean; maxNotionalUusd: string; maxLeverage: number }[] }>("/api/admin/live-products", {
        method: "POST",
        body: JSON.stringify({
          product: row.product,
          enabled: row.enabled,
          maxNotionalUsd: row.maxNotionalUsd.trim(),
          maxLeverage: leverage,
          totp: totp.trim(),
        }),
      });
      setRows(res.products.map((item) => ({ product: item.product, enabled: item.enabled, maxNotionalUsd: usdToInput(item.maxNotionalUusd), maxLeverage: String(item.maxLeverage) })));
      setTotp("");
      setNote(tri(lang, "已记下，并写入审计。", "Saved and written to the audit log.", "Disimpan dan dicatat dalam audit."));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  }

  if (error === "FORBIDDEN") return null;
  return (
    <section className="panel">
      <h2>{tri(lang, "产品开关", "Product switches", "Suis produk")}</h2>
      <p className="hint">{tri(
        lang,
        "默认关闭。打开后，已核验客户可以用真实余额交易。关闭后只能减仓或平仓。名义上限 1 到 1,000,000 美元，杠杆 2 到 10。每次保存都要所有者的 6 位动态验证码。",
        "Off by default. On means verified customers can trade with real balances. Off means reduce or close only. Notional cap is 1 to 1,000,000 USD and leverage is 2 to 10. Each save needs the owner's 6-digit authenticator code.",
        "Tutup secara lalai. Buka bermaksud pelanggan disahkan boleh berdagang dengan baki sebenar. Tutup bermaksud kurang atau tutup sahaja. Had nilai ialah 1 hingga 1,000,000 USD dan leveraj ialah 2 hingga 10. Setiap simpan perlukan kod pengesah 6 digit pemilik.",
      )}</p>
      {rows === null && !error ? <p className="hint">{tri(lang, "正在读取开关…", "Loading switches…", "Memuatkan suis…")}</p> : null}
      {rows && rows.length === 0 ? <p className="hint">{tri(lang, "还没有产品开关。", "No product switches yet.", "Belum ada suis produk.")}</p> : null}
      {error && error !== "FORBIDDEN" ? <p className="err" role="alert">{reasonText(lang, error)}</p> : null}
      {note ? <p className="hint">{note}</p> : null}
      <label>{tri(lang, "验证码", "Authenticator", "Kod pengesah")}
        <input className="desk-input" value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} />
      </label>
      {(rows ?? []).map((row) => (
        <div key={row.product} className="split" style={{ marginTop: 12 }}>
          <div>
            <b>{names[row.product] ?? row.product}</b>
            <div className="btn-row">
              <Button type="button" variant={row.enabled ? "default" : "outline"} onClick={() => setRows((rows ?? []).map((item) => item.product === row.product ? { ...item, enabled: true } : item))}>ON</Button>
              <Button type="button" variant={!row.enabled ? "default" : "outline"} onClick={() => setRows((rows ?? []).map((item) => item.product === row.product ? { ...item, enabled: false } : item))}>OFF</Button>
            </div>
          </div>
          <label>{tri(lang, "名义上限 USD", "Notional cap USD", "Had nilai USD")}
            <input className="desk-input" value={row.maxNotionalUsd} inputMode="decimal" onChange={(e) => setRows((rows ?? []).map((item) => item.product === row.product ? { ...item, maxNotionalUsd: e.target.value } : item))} />
          </label>
          <label>{tri(lang, "最大杠杆", "Max leverage", "Leveraj maks")}
            <input className="desk-input" value={row.maxLeverage} inputMode="numeric" onChange={(e) => setRows((rows ?? []).map((item) => item.product === row.product ? { ...item, maxLeverage: e.target.value.replace(/\D/g, "").slice(0, 2) } : item))} />
          </label>
          <Button type="button" disabled={busy === row.product} onClick={() => void save(row)}>{busy === row.product ? tri(lang, "正在保存…", "Saving…", "Menyimpan…") : tri(lang, "保存", "Save", "Simpan")}</Button>
        </div>
      ))}
    </section>
  );
}
