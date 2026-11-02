"use client";

import { useEffect, useState } from "react";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { tri } from "@/lib/tri";
import { useI18n } from "@/lib/i18n";

type Mode = "off" | "shadow" | "live";
type Provider = {
  id: number;
  name: string;
  type: string;
  baseUrl: string;
  enabled: boolean;
  mode: Mode;
  priority: number;
  spreadMarkupBps: number;
  minQty: string;
  maxQty: string;
  perOrderNotionalUusd: string;
  dailyNotionalUusd: string;
  symbolMap: Record<string, string>;
  key: "unset" | "present" | "missing";
  health: string;
  healthDetail: string;
  latencyMs: number | null;
  lastError: string;
  todayNotionalUusd: string;
  rejectRate: number;
  shadowDiffBps: string;
};
type Exposure = { asset: string; routedQty: string; hedgeQty: string; netQty: string; capQty: string };
type Mark = { id: string; enabled: boolean; symbol: string; mapped: string | null; px: string | null; at: number | null; error: string; note: string };
type Source = { id: string; enabled: boolean; stale_ms: number; outlier_bps: number; note: string };
type AlertRow = { id: number; kind: string; asset: string | null; created_at: string };
type Overview = {
  kill: boolean;
  providers: Provider[];
  exposure: Exposure[];
  marks: Mark[];
  markSources: Source[];
  alerts: AlertRow[];
};

type Pending =
  | { kind: "provider"; row: Provider; mode: Mode }
  | { kind: "kill"; stopped: boolean }
  | { kind: "mark"; id: string; enabled: boolean }
  | { kind: "cap" }
  | null;

function usd(micro: string): string {
  const n = Number(micro);
  if (!Number.isFinite(n)) return micro;
  return (n / 1_000_000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function LiquidityPage() {
  const { lang } = useI18n();
  const t = (zh: string, en: string, ms: string) => tri(lang, zh, en, ms);
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Pending>(null);
  const [totp, setTotp] = useState("");
  const [busy, setBusy] = useState(false);
  const [perOrder, setPerOrder] = useState("");
  const [daily, setDaily] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [testing, setTesting] = useState(0);
  const [capAsset, setCapAsset] = useState("BTC");
  const [capQty, setCapQty] = useState("0");
  const [csvName, setCsvName] = useState("");
  const [csv, setCsv] = useState("");
  const [providerId, setProviderId] = useState(0);
  const [importNote, setImportNote] = useState("");

  function load() {
    setLoading(true);
    api<Overview>("/api/admin/liquidity")
      .then((res) => {
        setData(res);
        setError("");
        if (!providerId && res.providers[0]) setProviderId(res.providers[0].id);
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

  function keyLabel(key: Provider["key"]) {
    if (key === "present") return t("已配置", "Present", "Ada");
    if (key === "missing") return t("未配置", "Missing", "Tiada");
    return t("未命名", "Unset", "Kosong");
  }

  function isTest(name: string) {
    return name === "binance-demo" || name === "saxo-sim" || name === "coinbase-sandbox";
  }

  function statusText(code: string) {
    if (code === "OK" || code === "") return t("已连接", "Connected", "Bersambung");
    if (code === "KEY_MISSING") return t("密钥缺失", "Key missing", "Kunci tiada");
    if (code === "HOST_REFUSED") return t("拒绝生产地址", "Production host refused", "Hos produksi ditolak");
    if (code === "TOKEN_EXPIRED") return t("令牌已过期", "Token expired", "Token tamat");
    if (code === "STUB") return t("还没有密钥，未连接", "No key yet, not connected", "Belum ada kunci, tidak disambung");
    if (code === "NOT_TESTED") return t("未测试", "Not tested", "Belum diuji");
    if (code === "UNREACHABLE") return t("连不上", "Unreachable", "Tidak dapat dihubungi");
    if (code.startsWith("BINANCE_") || code.startsWith("HTTP_")) return t("对方拒绝", "Venue refused", "Tempat menolak");
    return code;
  }

  function providerHint(row: Provider) {
    if (row.name === "binance-demo") return "~/.meridex-secrets/binance-demo.env";
    if (row.name === "saxo-sim") return "~/.meridex-secrets/saxo-sim.env";
    if (row.name === "coinbase-sandbox") return t("沙盒尚未接线", "Sandbox not wired", "Kotak pasir belum disambung");
    if (row.type === "mock") return row.type;
    return `${row.type}${t(" · 需要对方文档", " · needs their docs", " · perlukan dokumen mereka")}`;
  }

  async function save() {
    if (!pending) return;
    setBusy(true);
    setError("");
    try {
      if (pending.kind === "provider") {
        const row = pending.row;
        await api(`/api/admin/liquidity/providers/${row.id}`, {
          method: "POST",
          body: JSON.stringify({
            mode: pending.mode,
            enabled: pending.mode !== "off",
            spreadMarkupBps: row.spreadMarkupBps,
            minQty: row.minQty,
            maxQty: row.maxQty,
            perOrderNotionalUusd: perOrder || row.perOrderNotionalUusd,
            dailyNotionalUusd: daily || row.dailyNotionalUusd,
            priority: row.priority,
            symbolMap: row.symbolMap,
            baseUrl: isTest(row.name) ? baseUrl : row.baseUrl,
            totp,
          }),
        });
      } else if (pending.kind === "kill") {
        await api("/api/admin/liquidity/kill", { method: "POST", body: JSON.stringify({ stopped: pending.stopped, totp }) });
      } else if (pending.kind === "mark") {
        await api(`/api/admin/liquidity/marks/${pending.id}`, { method: "POST", body: JSON.stringify({ enabled: pending.enabled, totp }) });
      } else {
        await api("/api/admin/liquidity/exposure", { method: "POST", body: JSON.stringify({ asset: capAsset.trim().toUpperCase(), maxAbsQty: capQty, totp }) });
      }
      setPending(null);
      setTotp("");
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function testConnection(id: number) {
    setTesting(id);
    setError("");
    try {
      await api(`/api/admin/liquidity/providers/${id}/test`, { method: "POST", body: "{}" });
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTesting(0);
    }
  }

  async function upload(file: File | null) {
    if (!file) return;
    const text = await file.text();
    setCsv(text);
    setCsvName(file.name);
    setImportNote("");
  }

  async function runImport() {
    setError("");
    setImportNote("");
    try {
      const res = await api<{ matched: number; breaks: number }>("/api/admin/liquidity/statements", {
        method: "POST",
        body: JSON.stringify({ providerId, csv }),
      });
      setImportNote(t(
        `核对 ${res.matched} 笔，差异 ${res.breaks} 笔。客户余额没有改动。`,
        `Matched ${res.matched}, breaks ${res.breaks}. Customer balances were not changed.`,
        `Padan ${res.matched}, beza ${res.breaks}. Baki pelanggan tidak berubah.`,
      ));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const providers = data?.providers ?? [];

  return (
    <Shell>
      <div className="page">
        <section className="panel">
          <div className="kicker">MERIDEX</div>
          <h1>{t("流动性", "Liquidity", "Kecairan")}</h1>
          <p className="hint">{t(
            "外部做市默认关闭。影子模式只记录对照，不向外发送。实盘需要所有者验证器，并先把单笔和每日上限设成很小的数。",
            "External routing is off. Shadow only records a comparison and sends nothing. Live needs the owner's authenticator, and tiny per-order and daily caps.",
            "Penghalaan luar dimatikan. Bayang hanya merekod perbandingan dan tidak menghantar. Langsung perlukan kod pemilik, dengan had kecil.",
          )}</p>
          {error ? <p className="err" role="alert">{error}</p> : null}
          {loading ? <p className="hint">{t("正在加载…", "Loading…", "Memuatkan…")}</p> : null}
          {data ? (
            <div className={data.kill ? "kill-banner" : "kill-banner"} style={data.kill ? undefined : { borderColor: "rgba(61,220,151,0.55)" }}>
              <div>
                <strong>{data.kill ? t("外部路由已停止", "External routing is stopped", "Penghalaan luar dihentikan") : t("外部路由可以开启", "External routing can run", "Penghalaan luar boleh berjalan")}</strong>
                <p className="hint">{t("停止后，新的实盘单会被拒绝。已经发出的成交仍可记账。", "Stopping rejects new live orders. A fill already sent can still be recorded.", "Berhenti menolak pesanan langsung baharu. Isian yang sudah dihantar masih boleh direkod.")}</p>
              </div>
              <Button variant={data.kill ? "outline" : "danger"} onClick={() => { setTotp(""); setPending({ kind: "kill", stopped: !data.kill }); }}>
                {data.kill ? t("恢复路由", "Resume routing", "Sambung semula") : t("紧急停止", "Kill switch", "Henti kecemasan")}
              </Button>
            </div>
          ) : null}
          {!loading && providers.length === 0 ? <p className="hint">{t("没有流动性来源。", "No providers.", "Tiada penyedia.")}</p> : null}
          {providers.length > 0 ? (
            <div className="scroll-table">
              <table>
                <thead>
                  <tr>
                    <th>{t("来源", "Provider", "Penyedia")}</th>
                    <th>{t("模式", "Mode", "Mod")}</th>
                    <th>{t("密钥", "Key", "Kunci")}</th>
                    <th>{t("连接", "Health", "Sambungan")}</th>
                    <th>{t("今日名义", "Today", "Hari ini")}</th>
                    <th>{t("拒绝率", "Rejects", "Tolakan")}</th>
                    <th>{t("影子价差", "Shadow gap", "Jurang bayang")}</th>
                  </tr>
                </thead>
                <tbody>
                  {providers.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <div>{row.name}</div>
                        <div className="hint">{providerHint(row)}</div>
                      </td>
                      <td className="actions">
                        {(["off", "shadow", "live"] as Mode[]).map((mode) => (
                          <button
                            key={mode}
                            type="button"
                            className={row.mode === mode ? "pill on" : "pill"}
                            onClick={() => {
                              setPerOrder(row.perOrderNotionalUusd);
                              setDaily(row.dailyNotionalUusd);
                              setBaseUrl(row.baseUrl);
                              setTotp("");
                              setPending({ kind: "provider", row, mode });
                            }}
                          >
                            {mode === "off" ? t("关", "Off", "Tutup") : mode === "shadow" ? t("影子", "Shadow", "Bayang") : isTest(row.name) ? t("测试环境", "Test venue", "Persekitaran ujian") : t("实盘", "Live", "Langsung")}
                          </button>
                        ))}
                      </td>
                      <td>{keyLabel(row.key)}</td>
                      <td className="wrap">
                        {isTest(row.name) ? (
                          <>
                            <div>{statusText(row.health === "up" ? "OK" : (row.lastError || row.healthDetail))}</div>
                            {row.latencyMs != null ? <div className="hint">{row.latencyMs} ms</div> : null}
                            <button type="button" className="pill" disabled={testing === row.id} onClick={() => void testConnection(row.id)}>
                              {testing === row.id ? t("测试中…", "Testing…", "Menguji…") : t("测试连接", "Test connection", "Uji sambungan")}
                            </button>
                          </>
                        ) : (row.health === "up" ? t("正常", "Up", "Hidup") : t("中断", "Down", "Terputus"))}
                      </td>
                      <td>{usd(row.todayNotionalUusd)}</td>
                      <td>{(row.rejectRate * 100).toFixed(1)}%</td>
                      <td>{Number(row.shadowDiffBps).toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>

        <section className="panel">
          <h2>{t("敞口与对冲", "Exposure and hedge", "Dedahan dan lindung nilai")}</h2>
          {!loading && (data?.exposure.length ?? 0) === 0 ? <p className="hint">{t("还没有已发送的对冲。", "No hedge has been sent.", "Tiada lindung nilai dihantar.")}</p> : null}
          {(data?.exposure.length ?? 0) > 0 ? (
            <div className="scroll-table">
              <table>
                <thead>
                  <tr>
                    <th>{t("资产", "Asset", "Aset")}</th>
                    <th>{t("客户成交", "Customer", "Pelanggan")}</th>
                    <th>{t("对冲", "Hedge", "Lindung nilai")}</th>
                    <th>{t("净额", "Net", "Bersih")}</th>
                    <th>{t("上限", "Cap", "Had")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.exposure.map((row) => (
                    <tr key={row.asset}>
                      <td>{row.asset}</td>
                      <td>{row.routedQty}</td>
                      <td>{row.hedgeQty}</td>
                      <td>{row.netQty}</td>
                      <td>{row.capQty}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <p className="hint">{t("上限为 0 表示还没设置，不会因为敞口报警。", "A cap of 0 is unset and does not alert.", "Had 0 bermaksud belum ditetapkan dan tidak memberi amaran.")}</p>
          <Button variant="outline" onClick={() => { setTotp(""); setPending({ kind: "cap" }); }}>{t("设置敞口上限", "Set exposure cap", "Tetapkan had dedahan")}</Button>
        </section>

        <section className="panel">
          <h2>{t("标记价来源", "Mark sources", "Sumber harga tanda")}</h2>
          <p className="hint">{t(
            "三家公开现货价，不需要密钥。使用前请核对各自条款。偏离过大或来源不足时，保证金和永续仍用本机订单簿。",
            "Three public spot prices, no key. Verify each source's terms before you rely on them. A large gap or too few sources keeps the local book for margin and perpetuals.",
            "Tiga harga spot awam, tanpa kunci. Sahkan terma setiap sumber. Jurang besar atau sumber kurang kekal pada buku tempatan.",
          )}</p>
          {!loading && (data?.marks.length ?? 0) === 0 ? <p className="hint">{t("正在等待第一次取样。", "Waiting for the first sample.", "Menunggu sampel pertama.")}</p> : null}
          <div className="scroll-table">
            <table>
              <thead>
                <tr>
                  <th>{t("来源", "Source", "Sumber")}</th>
                  <th>{t("取样", "Samples", "Sampel")}</th>
                  <th>{t("价格", "Price", "Harga")}</th>
                  <th>{t("状态", "State", "Keadaan")}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(data?.markSources ?? []).map((source) => {
                  const samples = (data?.marks ?? []).filter((mark) => mark.id === source.id);
                  const fresh = samples.filter((mark) => mark.px);
                  const sample = fresh[0] ?? samples[0];
                  return (
                    <tr key={source.id}>
                      <td>{source.id}</td>
                      <td>{samples.length ? `${fresh.length}/${samples.length}` : "—"}</td>
                      <td>{sample?.px ?? "—"}</td>
                      <td>{fresh.length > 0 ? t("有报价", "Quoting", "Ada sebut harga") : sample?.error || (source.enabled ? t("启用", "On", "Hidup") : t("关闭", "Off", "Mati"))}</td>
                      <td>
                        <button type="button" className="pill" onClick={() => { setTotp(""); setPending({ kind: "mark", id: source.id, enabled: !source.enabled }); }}>
                          {source.enabled ? t("关闭", "Disable", "Matikan") : t("启用", "Enable", "Hidupkan")}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel">
          <h2>{t("告警", "Alerts", "Amaran")}</h2>
          {(data?.alerts.length ?? 0) === 0 ? <p className="hint">{t("没有未处理的告警。", "No alerts.", "Tiada amaran.")}</p> : (
            <ul>
              {data?.alerts.map((row) => (
                <li key={row.id}>{row.kind} · {row.asset || "—"} · {new Date(row.created_at).toLocaleString()}</li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <h2>{t("对账导入", "Statement import", "Import penyata")}</h2>
          <p className="hint">{t(
            "CSV 列：fill_id, client_order_id, symbol, side, qty, px。差异只进队列，不会改客户余额。",
            "CSV columns: fill_id, client_order_id, symbol, side, qty, px. Breaks stay in a queue and do not change a customer balance.",
            "Lajur CSV: fill_id, client_order_id, symbol, side, qty, px. Beza kekal dalam barisan dan tidak mengubah baki.",
          )}</p>
          <div className="filters">
            <select className="desk-input" value={providerId} onChange={(e) => setProviderId(Number(e.target.value))}>
              {providers.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
            </select>
            <input className="desk-input" type="file" accept=".csv,text/csv,text/plain" onChange={(e) => void upload(e.target.files?.[0] ?? null)} />
            <Button variant="outline" disabled={!csv || !providerId} onClick={() => void runImport()}>{t("导入", "Import", "Import")}</Button>
          </div>
          {csvName ? <p className="hint">{csvName}</p> : null}
          {importNote ? <p className="okline">{importNote}</p> : null}
        </section>

        {pending ? (
          <div className="sheet" role="dialog">
            <div className="panel">
              <h2>{t("所有者验证", "Owner authenticator", "Pengesah pemilik")}</h2>
              <p className="hint">
                {pending.kind === "kill"
                  ? (pending.stopped ? t("停止新的外部路由。", "Stop new external routing.", "Hentikan penghalaan luar baharu.") : t("恢复外部路由开关。模式本身仍是关、影子或实盘。", "Allow routing again. Each provider stays off, shadow, or live.", "Benarkan penghalaan semula. Setiap penyedia kekal tutup, bayang, atau langsung."))
                  : pending.kind === "provider" && isTest(pending.row.name)
                    ? (pending.mode === "shadow"
                      ? t("影子只记下打算发给测试环境的路由，不发送任何订单。", "Shadow logs the route it would send to the test venue and sends nothing.", "Bayang merekod laluan ke persekitaran ujian dan tidak menghantar.")
                      : pending.mode === "live"
                        ? t("打开后，订单只会发到这家测试环境（演示或模拟），不会发到生产。仍需要所有者验证器。上限为 0 时仍会拒绝。", "Orders go only to this test venue (demo or simulation), not production. The owner's authenticator is still required. A cap of zero still rejects the order.", "Pesanan hanya ke persekitaran ujian ini, bukan produksi. Kod pemilik masih diperlukan. Had sifar tetap menolak.")
                        : t("关闭这一来源。", "Turn this provider off.", "Matikan penyedia ini."))
                    : pending.kind === "provider"
                    ? t(`把 ${pending.row.name} 设为 ${pending.mode}。实盘会拒绝没有上限的单。`, `Set ${pending.row.name} to ${pending.mode}. Live rejects an order when a cap is still zero.`, `Tetapkan ${pending.row.name} kepada ${pending.mode}. Langsung menolak jika had masih sifar.`)
                    : t("保存这一项。", "Save this.", "Simpan ini.")}
              </p>
              {pending.kind === "provider" && isTest(pending.row.name) ? (
                <label>{t("测试环境地址", "Test venue URL", "URL persekitaran ujian")}
                  <input className="desk-input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
                </label>
              ) : null}
              {pending.kind === "provider" && pending.mode === "live" ? (
                <>
                  <label>{t("单笔上限（微美元）", "Per-order cap (micro-USD)", "Had setiap pesanan (mikro-USD)")}
                    <input className="desk-input" value={perOrder} onChange={(e) => setPerOrder(e.target.value)} />
                  </label>
                  <label>{t("每日上限（微美元）", "Daily cap (micro-USD)", "Had harian (mikro-USD)")}
                    <input className="desk-input" value={daily} onChange={(e) => setDaily(e.target.value)} />
                  </label>
                </>
              ) : null}
              {pending.kind === "cap" ? (
                <>
                  <label>{t("资产", "Asset", "Aset")}
                    <input className="desk-input" value={capAsset} onChange={(e) => setCapAsset(e.target.value)} />
                  </label>
                  <label>{t("净数量上限", "Max net quantity", "Kuantiti bersih maksimum")}
                    <input className="desk-input" value={capQty} onChange={(e) => setCapQty(e.target.value)} />
                  </label>
                </>
              ) : null}
              <label>{t("验证码", "Authenticator code", "Kod pengesah")}
                <input className="desk-input" value={totp} inputMode="numeric" autoComplete="one-time-code" onChange={(e) => setTotp(e.target.value)} />
              </label>
              <div className="actions">
                <Button disabled={busy} onClick={() => void save()}>{t("确认", "Confirm", "Sahkan")}</Button>
                <Button variant="ghost" onClick={() => setPending(null)}>{t("取消", "Cancel", "Batal")}</Button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </Shell>
  );
}
