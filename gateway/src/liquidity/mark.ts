import type { Db } from "../db.js";
import { getInstrument } from "../instruments.js";

/**
 * Multi-source mark. The random-walk fallback in feeds.ts is not a source.
 * Public endpoints are read-only and need no key. Confirm each vendor's terms
 * before treating the number as a production index. See lp_mark_sources.note.
 */

export type MarkPrint = { source: string; px: bigint; at: number };

export type MedianResult = {
  mark: bigint | null;
  used: MarkPrint[];
  dropped: MarkPrint[];
  disagree: boolean;
};

const houseCache = new Map<number, boolean>();

export function clearHouseCache() {
  houseCache.clear();
}

export async function isHouseUser(pool: Db, userId: number): Promise<boolean> {
  const hit = houseCache.get(userId);
  if (hit != null) return hit;
  const row = await pool.query(`SELECT role, email FROM users WHERE id = $1`, [userId]);
  const email = String(row.rows[0]?.email ?? "");
  const house = row.rows[0]?.role === "bot" || email.endsWith("@internal.meridex");
  houseCache.set(userId, house);
  return house;
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

function median(values: bigint[]): bigint {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2n;
}

function within(px: bigint, mid: bigint, bps: number): boolean {
  if (mid <= 0n) return false;
  return abs(px - mid) * 10_000n <= mid * BigInt(bps);
}

/** Drop stale prints, then drop prints far from the median. Need two survivors. */
export function medianIndex(prints: MarkPrint[], now: number, staleMs: number, outlierBps: number): MedianResult {
  const fresh = prints.filter((print) => print.px > 0n && now - print.at <= staleMs && now - print.at >= 0);
  const stale = prints.filter((print) => !fresh.includes(print));
  if (fresh.length === 0) return { mark: null, used: [], dropped: stale, disagree: false };
  const mid = median(fresh.map((print) => print.px));
  const used = fresh.filter((print) => within(print.px, mid, outlierBps));
  const dropped = [...stale, ...fresh.filter((print) => !used.includes(print))];
  if (used.length < 2) return { mark: null, used, dropped, disagree: fresh.length >= 2 };
  return { mark: median(used.map((print) => print.px)), used, dropped, disagree: dropped.some((print) => fresh.includes(print)) };
}

export function pickMark(book: bigint, external: bigint | null, maxDriftBps: number): { px: bigint; usedExternal: boolean; drifted: boolean } {
  if (external == null || external <= 0n) return { px: book, usedExternal: false, drifted: false };
  if (book <= 0n) return { px: external, usedExternal: true, drifted: false };
  const drifted = abs(external - book) * 10_000n > book * BigInt(maxDriftBps);
  if (drifted) return { px: book, usedExternal: false, drifted: true };
  return { px: external, usedExternal: true, drifted: false };
}

type SourceRow = {
  id: string;
  enabled: boolean;
  staleMs: number;
  outlierBps: number;
  maxDriftBps: number;
  symbolMap: Record<string, string>;
  note: string;
};

type Health = {
  id: string;
  enabled: boolean;
  symbol: string;
  mapped: string | null;
  px: string | null;
  at: number | null;
  error: string;
  note: string;
};

type Cache = { at: number; prints: MarkPrint[]; mark: bigint | null; disagree: boolean; staleMs: number; outlierBps: number; maxDriftBps: number };

const cache = new Map<string, Cache>();
const health = new Map<string, Health>();
let poolRef: Db | null = null;
let timer: NodeJS.Timeout | null = null;
let alerted = new Map<string, number>();

export function bindLiquidityPool(pool: Db) {
  poolRef = pool;
}

export function markSnapshot(symbol: string): Cache | null {
  return cache.get(symbol) ?? null;
}

export function markHealth(): Health[] {
  return [...health.values()];
}

async function sources(pool: Db): Promise<SourceRow[]> {
  const rows = await pool.query(
    `SELECT id, enabled, stale_ms, outlier_bps, max_book_drift_bps, symbol_map, note FROM lp_mark_sources ORDER BY id`,
  );
  return rows.rows.map((row) => ({
    id: String(row.id),
    enabled: Boolean(row.enabled),
    staleMs: Number(row.stale_ms),
    outlierBps: Number(row.outlier_bps),
    maxDriftBps: Number(row.max_book_drift_bps),
    symbolMap: row.symbol_map && typeof row.symbol_map === "object" ? (row.symbol_map as Record<string, string>) : {},
    note: String(row.note ?? ""),
  }));
}

async function grab(url: string): Promise<unknown | null> {
  const ctrl = new AbortController();
  const timerId = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json", "user-agent": "meridex-sandbox/1.0" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timerId);
  }
}

function usdToPx(usd: number, scale: number): bigint {
  if (!Number.isFinite(usd) || usd <= 0) return 0n;
  return BigInt(Math.max(1, Math.round(usd * scale)));
}

async function fetchOne(id: string, mapped: string): Promise<number | null> {
  if (id === "binance") {
    const body = await grab(`https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(mapped)}`);
    const px = Number((body as { price?: string } | null)?.price);
    return Number.isFinite(px) && px > 0 ? px : null;
  }
  if (id === "coinbase") {
    const body = await grab(`https://api.coinbase.com/v2/prices/${encodeURIComponent(mapped)}/spot`);
    const px = Number((body as { data?: { amount?: string } } | null)?.data?.amount);
    return Number.isFinite(px) && px > 0 ? px : null;
  }
  if (id === "coingecko") {
    const body = await grab(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(mapped)}&vs_currencies=usd`);
    const px = Number((body as Record<string, { usd?: number }> | null)?.[mapped]?.usd);
    return Number.isFinite(px) && px > 0 ? px : null;
  }
  if (id === "kraken") {
    const body = await grab(`https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(mapped)}`);
    const result = (body as { result?: Record<string, { c?: string[] }> } | null)?.result;
    const first = result ? Object.values(result)[0] : null;
    const px = Number(first?.c?.[0]);
    return Number.isFinite(px) && px > 0 ? px : null;
  }
  return null;
}

export async function refreshMarks(pool: Db = poolRef as Db): Promise<void> {
  if (!pool) return;
  const list = await sources(pool);
  const symbols = new Set<string>();
  for (const source of list) for (const key of Object.keys(source.symbolMap)) symbols.add(key);
  const now = Date.now();
  for (const symbol of symbols) {
    let inst;
    try {
      inst = getInstrument(symbol);
    } catch {
      continue;
    }
    const prints: MarkPrint[] = [];
    let staleMs = 30_000;
    let outlierBps = 100;
    let maxDriftBps = 500;
    for (const source of list) {
      const mapped = source.symbolMap[symbol];
      const slot: Health = {
        id: source.id,
        enabled: source.enabled,
        symbol,
        mapped: mapped ?? null,
        px: null,
        at: null,
        error: "",
        note: source.note,
      };
      if (!source.enabled || !mapped) {
        slot.error = source.enabled ? "unmapped" : "disabled";
        health.set(`${source.id}:${symbol}`, slot);
        continue;
      }
      staleMs = source.staleMs;
      outlierBps = source.outlierBps;
      maxDriftBps = source.maxDriftBps;
      const usd = await fetchOne(source.id, mapped);
      if (usd == null) {
        slot.error = "unavailable";
        health.set(`${source.id}:${symbol}`, slot);
        continue;
      }
      const px = usdToPx(usd, inst.priceScale);
      slot.px = px.toString();
      slot.at = now;
      health.set(`${source.id}:${symbol}`, slot);
      prints.push({ source: source.id, px, at: now });
    }
    const combined = medianIndex(prints, now, staleMs, outlierBps);
    cache.set(symbol, { at: now, prints, mark: combined.mark, disagree: combined.disagree, staleMs, outlierBps, maxDriftBps });
    if (combined.disagree) void raiseMarkAlert(pool, symbol, combined.dropped.map((print) => print.source));
  }
  for (const source of list) {
    if ([...health.keys()].some((key) => key.startsWith(`${source.id}:`))) continue;
    health.set(source.id, {
      id: source.id,
      enabled: source.enabled,
      symbol: "",
      mapped: null,
      px: null,
      at: null,
      error: source.enabled ? "no symbols" : "disabled",
      note: source.note,
    });
  }
}

async function raiseMarkAlert(pool: Db, symbol: string, dropped: string[]) {
  const key = `mark:${symbol}`;
  const prev = alerted.get(key) ?? 0;
  if (Date.now() - prev < 15 * 60_000) return;
  alerted.set(key, Date.now());
  await pool.query(`INSERT INTO lp_alerts (kind, asset, detail) VALUES ('mark_disagree', $1, $2::jsonb)`, [
    symbol,
    JSON.stringify({ dropped }),
  ]);
  await notifyOwner(pool, "标记价来源不一致", `${symbol} 有来源被剔除或互相偏离。已回退到本机订单簿。`);
}

export async function notifyOwner(pool: Db, title: string, body: string) {
  const owner = await pool.query(`SELECT id FROM users WHERE address_pool_owner = true ORDER BY id LIMIT 1`);
  if (!owner.rowCount) return;
  await pool.query(
    `INSERT INTO notification_outbox (id, user_id, channel, title, body, provider, status)
     VALUES ($1,$2,'inapp',$3,$4,'inapp','mock_sent')`,
    [crypto.randomUUID(), owner.rows[0].id, title.slice(0, 120), body.slice(0, 400)],
  );
}

export function externalMark(symbol: string): { px: bigint; disagree: boolean; maxDriftBps: number } | null {
  const row = cache.get(symbol);
  if (!row || row.mark == null || row.mark <= 0n) return null;
  if (Date.now() - row.at > row.staleMs) return null;
  return { px: row.mark, disagree: row.disagree, maxDriftBps: row.maxDriftBps };
}

export function startMarkLoop() {
  if (timer) return;
  void refreshMarks().catch(() => undefined);
  timer = setInterval(() => {
    void refreshMarks().catch(() => undefined);
    void sweepProviderHealth().catch(() => undefined);
  }, 20_000);
  timer.unref?.();
}

async function sweepProviderHealth() {
  if (!poolRef) return;
  const { loadProviders, providerFor } = await import("./registry.js");
  const { raiseAlert } = await import("./alerts.js");
  const rows = await loadProviders(poolRef);
  for (const row of rows) {
    if (!row.enabled || row.mode === "off") continue;
    const beat = await providerFor(row).heartbeat();
    if (!beat.ok) await raiseAlert(poolRef, "disconnect", row.name, { providerId: row.id, detail: beat.detail });
  }
  const { checkExposure } = await import("./route.js");
  await checkExposure(poolRef);
}

export function stopMarkLoop() {
  if (timer) clearInterval(timer);
  timer = null;
}
