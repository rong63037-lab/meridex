import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.js";
import { PlatformError } from "./errors.js";
import { overlayFeeNumbers, parseFeeKey, writeFeeKey } from "./fees.js";
import { requireFreshTotp } from "./pool.js";

const here = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(join(here, "customer-strings.json"), "utf8")) as Record<string, string>;

export type ParamSpec = {
  min: number;
  max: number;
  def: number;
  integer?: boolean;
  label: string;
};

export const PARAMS: Record<string, ParamSpec> = {
  "fee.standard.makerBps": { min: 0, max: 200, def: 10, integer: true, label: "Spot VIP 0 maker (bps)" },
  "fee.standard.takerBps": { min: 0, max: 200, def: 10, integer: true, label: "Spot VIP 0 taker (bps)" },
  "fee.silver.minUsd": { min: 0, max: 1_000_000_000_000, def: 1_000_000, integer: true, label: "Spot VIP 1 30d volume (USD)" },
  "fee.silver.makerBps": { min: 0, max: 200, def: 9, integer: true, label: "Spot VIP 1 maker (bps)" },
  "fee.silver.takerBps": { min: 0, max: 200, def: 10, integer: true, label: "Spot VIP 1 taker (bps)" },
  "fee.gold.minUsd": { min: 0, max: 1_000_000_000_000, def: 5_000_000, integer: true, label: "Spot VIP 2 30d volume (USD)" },
  "fee.gold.makerBps": { min: 0, max: 200, def: 8, integer: true, label: "Spot VIP 2 maker (bps)" },
  "fee.gold.takerBps": { min: 0, max: 200, def: 10, integer: true, label: "Spot VIP 2 taker (bps)" },
  "fee.private.minUsd": { min: 0, max: 1_000_000_000_000, def: 20_000_000, integer: true, label: "Spot VIP 3 30d volume (USD)" },
  "fee.private.makerBps": { min: 0, max: 200, def: 4, integer: true, label: "Spot VIP 3 maker (bps)" },
  "fee.private.takerBps": { min: 0, max: 200, def: 6, integer: true, label: "Spot VIP 3 taker (bps)" },
  "fee.spot4.minUsd": { min: 0, max: 1_000_000_000_000, def: 75_000_000, integer: true, label: "Spot VIP 4 30d volume (USD)" },
  "fee.spot4.makerBps": { min: 0, max: 200, def: 4, integer: true, label: "Spot VIP 4 maker (bps)" },
  "fee.spot4.takerBps": { min: 0, max: 200, def: 5, integer: true, label: "Spot VIP 4 taker (bps)" },
  "fee.perp0.makerBps": { min: 0, max: 200, def: 2, integer: true, label: "Perp VIP 0 maker (bps)" },
  "fee.perp0.takerBps": { min: 0, max: 200, def: 5, integer: true, label: "Perp VIP 0 taker (bps)" },
  "fee.perp1.minUsd": { min: 0, max: 1_000_000_000_000, def: 15_000_000, integer: true, label: "Perp VIP 1 30d volume (USD)" },
  "fee.perp1.makerBps": { min: 0, max: 200, def: 2, integer: true, label: "Perp VIP 1 maker (bps)" },
  "fee.perp1.takerBps": { min: 0, max: 200, def: 4, integer: true, label: "Perp VIP 1 taker (bps)" },
  "fee.perp2.minUsd": { min: 0, max: 1_000_000_000_000, def: 50_000_000, integer: true, label: "Perp VIP 2 30d volume (USD)" },
  "fee.perp2.makerBps": { min: 0, max: 200, def: 1, integer: true, label: "Perp VIP 2 maker (bps)" },
  "fee.perp2.takerBps": { min: 0, max: 200, def: 4, integer: true, label: "Perp VIP 2 taker (bps)" },
  "fee.perp3.minUsd": { min: 0, max: 1_000_000_000_000, def: 100_000_000, integer: true, label: "Perp VIP 3 30d volume (USD)" },
  "fee.perp3.makerBps": { min: 0, max: 200, def: 1, integer: true, label: "Perp VIP 3 maker (bps)" },
  "fee.perp3.takerBps": { min: 0, max: 200, def: 3, integer: true, label: "Perp VIP 3 taker (bps)" },
  "fee.perp4.minUsd": { min: 0, max: 1_000_000_000_000, def: 600_000_000, integer: true, label: "Perp VIP 4 30d volume (USD)" },
  "fee.perp4.makerBps": { min: 0, max: 200, def: 1, integer: true, label: "Perp VIP 4 maker (bps)" },
  "fee.perp4.takerBps": { min: 0, max: 200, def: 3, integer: true, label: "Perp VIP 4 taker (bps)" },
  "convert.feeBps": { min: 0, max: 200, def: 10, integer: true, label: "Convert fee (bps)" },
  "convert.spreadBps": { min: 0, max: 200, def: 8, integer: true, label: "Convert spread (bps)" },
  "withdraw.feeUsd": { min: 0, max: 10_000, def: 0, label: "Withdrawal fee (USD)" },
  "withdraw.minUsd": { min: 0, max: 1_000_000, def: 0, label: "Withdrawal minimum (USD, 0 = none)" },
  "withdraw.maxUsd": { min: 0, max: 100_000_000, def: 0, label: "Withdrawal maximum (USD, 0 = none)" },
  "withdraw.reviewUsd": { min: 0, max: 100_000_000, def: 0, label: "Withdrawal review threshold (USD, 0 = every withdrawal waits)" },
  "deposit.feeUsd": { min: 0, max: 10_000, def: 0, label: "Deposit fee (USD)" },
  "deposit.minUsd": { min: 0, max: 1_000_000, def: 0, label: "Deposit minimum (USD, 0 = none)" },
  "deposit.maxUsd": { min: 0, max: 100_000_000, def: 0, label: "Deposit maximum (USD, 0 = none)" },
  "deposit.flagUsd": { min: 0, max: 100_000_000, def: 10_000, label: "Manual deposit surveillance flag (USD, 0 = off)" },
  "redeem.coin_1oz.feeUsd": { min: 0, max: 100_000, def: 15, label: "1 oz coin fee (USD)" },
  "redeem.coin_1oz.deliveryUsd": { min: 0, max: 100_000, def: 40, label: "1 oz coin delivery (USD)" },
  "redeem.bar_100g.feeUsd": { min: 0, max: 100_000, def: 25, label: "100 g bar fee (USD)" },
  "redeem.bar_100g.deliveryUsd": { min: 0, max: 100_000, def: 40, label: "100 g bar delivery (USD)" },
  "redeem.bar_1000g.feeUsd": { min: 0, max: 100_000, def: 80, label: "1 kg bar fee (USD)" },
  "redeem.bar_1000g.deliveryUsd": { min: 0, max: 100_000, def: 60, label: "1 kg bar delivery (USD)" },
  "home.statVolume": { min: 0, max: 1e15, def: 0, label: "Home volume override (0 = live)" },
  "home.statMarkets": { min: 0, max: 100_000, def: 0, integer: true, label: "Home market count (0 = live)" },
  "home.statPlaces": { min: 0, max: 100_000, def: 0, integer: true, label: "Home place count (0 = live)" },
};

const CACHE_MS = 2_000;

type PublicBody = {
  overrides: Record<string, string>;
  numbers: Record<string, number>;
  announcements: { id: string; title: string; body: string; banner: boolean }[];
  at: number;
};

let publicCache: { at: number; body: PublicBody } | null = null;
let numberCache: { at: number; values: Record<string, number> } | null = null;

export function bustContentCache() {
  publicCache = null;
  numberCache = null;
}

function langOf(fullKey: string): string {
  if (fullKey.startsWith("reason.")) return fullKey.split(".")[1] ?? "zh";
  if (/^(desk|account|funds|concierge)\./.test(fullKey)) return fullKey.split(".")[1] ?? "zh";
  return fullKey.split(".")[0] ?? "zh";
}

function assertCatalogKey(fullKey: string) {
  if (!Object.prototype.hasOwnProperty.call(catalog, fullKey)) throw new PlatformError("VALIDATION");
  if (fullKey.length > 180) throw new PlatformError("VALIDATION");
}

function checkNumber(key: string, value: number) {
  const spec = PARAMS[key];
  if (!spec || !Number.isFinite(value)) throw new PlatformError("VALIDATION");
  if (spec.integer && !Number.isInteger(value)) throw new PlatformError("VALIDATION");
  if (value < spec.min || value > spec.max) throw new PlatformError("VALIDATION");
}

async function writeAudit(pool: Db, actorId: number, lang: string, key: string, oldValue: string | null, newValue: string | null) {
  await pool.query(
    `INSERT INTO content_audit (actor_id, lang, key, old_value, new_value) VALUES ($1,$2,$3,$4,$5)`,
    [actorId, lang, key, oldValue, newValue],
  );
}

async function readOverrides(pool: Db): Promise<Record<string, string>> {
  const rows = await pool.query(`SELECT lang, key, value FROM content_overrides`);
  const out: Record<string, string> = {};
  for (const row of rows.rows) out[String(row.key)] = String(row.value);
  return out;
}

async function readAnnouncements(pool: Db) {
  const rows = await pool.query(
    `SELECT id, title, body, banner, active, created_at FROM announcements ORDER BY created_at DESC LIMIT 40`,
  );
  return rows.rows as { id: string; title: string; body: string; banner: boolean; active: boolean; created_at: string }[];
}

export async function loadNumbers(pool: Db): Promise<Record<string, number>> {
  if (numberCache && Date.now() - numberCache.at < CACHE_MS) return numberCache.values;
  const values: Record<string, number> = {};
  for (const [key, spec] of Object.entries(PARAMS)) values[key] = spec.def;
  const fees = await pool.query(`SELECT vip_tier, maker_bps, taker_bps FROM fee_schedules`);
  for (const row of fees.rows) {
    const tier = String(row.vip_tier);
    if (PARAMS[`fee.${tier}.makerBps`]) {
      values[`fee.${tier}.makerBps`] = Number(row.maker_bps);
      values[`fee.${tier}.takerBps`] = Number(row.taker_bps);
    }
  }
  const tiers = await pool.query(
    `SELECT product, tier, min_volume_uusd::text, maker_bps, taker_bps FROM fee_tiers`,
  );
  overlayFeeNumbers(
    values,
    tiers.rows.map((row) => ({
      product: String(row.product),
      tier: Number(row.tier),
      min_volume_uusd: String(row.min_volume_uusd),
      maker_bps: Number(row.maker_bps),
      taker_bps: Number(row.taker_bps),
    })),
  );
  const rows = await pool.query(`SELECT key, value FROM business_params`);
  for (const row of rows.rows) {
    const key = String(row.key);
    if (!PARAMS[key] || key.startsWith("fee.")) continue;
    const n = Number(row.value);
    if (Number.isFinite(n)) values[key] = n;
  }
  numberCache = { at: Date.now(), values };
  return values;
}

export async function publicContent(pool: Db): Promise<PublicBody> {
  if (publicCache && Date.now() - publicCache.at < CACHE_MS) return publicCache.body;
  const [overrides, numbers, announcements] = await Promise.all([
    readOverrides(pool),
    loadNumbers(pool),
    pool.query(`SELECT id, title, body, banner FROM announcements WHERE active = true ORDER BY created_at DESC LIMIT 6`),
  ]);
  const body: PublicBody = {
    overrides,
    numbers,
    announcements: announcements.rows as PublicBody["announcements"],
    at: Date.now(),
  };
  publicCache = { at: body.at, body };
  return body;
}

export async function adminContent(pool: Db) {
  const [overrides, numbers, announcements] = await Promise.all([readOverrides(pool), loadNumbers(pool), readAnnouncements(pool)]);
  const strings = Object.entries(catalog).map(([key, def]) => ({
    key,
    lang: langOf(key),
    value: overrides[key] ?? def,
    default: def,
    overridden: Object.prototype.hasOwnProperty.call(overrides, key),
  }));
  return {
    strings,
    numbers: Object.entries(PARAMS).map(([key, spec]) => ({
      key,
      value: numbers[key] ?? spec.def,
      min: spec.min,
      max: spec.max,
      def: spec.def,
      integer: Boolean(spec.integer),
      label: spec.label,
    })),
    announcements,
  };
}

export async function setString(pool: Db, actorId: number, fullKey: string, value: string) {
  assertCatalogKey(fullKey);
  const next = value.slice(0, 4000);
  const lang = langOf(fullKey);
  const prev = await pool.query(`SELECT value FROM content_overrides WHERE lang = $1 AND key = $2`, [lang, fullKey]);
  const oldValue = prev.rowCount ? String(prev.rows[0].value) : catalog[fullKey];
  await pool.query(
    `INSERT INTO content_overrides (lang, key, value, updated_by, updated_at) VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (lang, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [lang, fullKey, next, actorId],
  );
  await writeAudit(pool, actorId, lang, fullKey, oldValue, next);
  bustContentCache();
  return { key: fullKey, value: next };
}

export async function resetString(pool: Db, actorId: number, fullKey: string) {
  assertCatalogKey(fullKey);
  const lang = langOf(fullKey);
  const prev = await pool.query(`DELETE FROM content_overrides WHERE lang = $1 AND key = $2 RETURNING value`, [lang, fullKey]);
  if (prev.rowCount) {
    await writeAudit(pool, actorId, lang, fullKey, String(prev.rows[0].value), catalog[fullKey]);
  }
  bustContentCache();
  return { key: fullKey, value: catalog[fullKey], reset: true };
}

export async function setNumber(pool: Db, actorId: number, key: string, value: number, totp?: string) {
  checkNumber(key, value);
  if (key.startsWith("fee.")) await requireFreshTotp(pool, actorId, totp);
  const current = await loadNumbers(pool);
  const oldValue = String(current[key] ?? PARAMS[key].def);
  if (parseFeeKey(key)) {
    await writeFeeKey(pool, key, value);
  } else {
    await pool.query(
      `INSERT INTO business_params (key, value, updated_by, updated_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, String(value), actorId],
    );
  }
  await writeAudit(pool, actorId, "number", key, oldValue, String(value));
  bustContentCache();
  return { key, value };
}

export async function resetNumber(pool: Db, actorId: number, key: string, totp?: string) {
  if (!PARAMS[key]) throw new PlatformError("VALIDATION");
  if (key.startsWith("fee.")) await requireFreshTotp(pool, actorId, totp);
  const current = await loadNumbers(pool);
  const spec = PARAMS[key];
  if (parseFeeKey(key)) await writeFeeKey(pool, key, spec.def);
  await pool.query(`DELETE FROM business_params WHERE key = $1`, [key]);
  if (String(current[key]) !== String(spec.def)) {
    await writeAudit(pool, actorId, "number", key, String(current[key]), String(spec.def));
  }
  bustContentCache();
  return { key, value: spec.def, reset: true };
}

export async function saveAnnouncement(
  pool: Db,
  actorId: number,
  input: { id?: string; title: string; body: string; banner: boolean; active: boolean },
) {
  const title = input.title.trim().slice(0, 80);
  const body = input.body.trim().slice(0, 400);
  if (!title || !body) throw new PlatformError("VALIDATION");
  if (input.id) {
    const prev = await pool.query(`SELECT title, body, banner, active FROM announcements WHERE id = $1`, [input.id]);
    if (!prev.rowCount) throw new PlatformError("NOT_FOUND", 404);
    await pool.query(`UPDATE announcements SET title = $2, body = $3, banner = $4, active = $5 WHERE id = $1`, [
      input.id,
      title,
      body,
      input.banner,
      input.active,
    ]);
    await writeAudit(pool, actorId, "announcement", input.id, JSON.stringify(prev.rows[0]), JSON.stringify({ title, body, banner: input.banner, active: input.active }));
    bustContentCache();
    return { id: input.id, title, body, banner: input.banner, active: input.active };
  }
  const id = crypto.randomUUID();
  await pool.query(`INSERT INTO announcements (id, title, body, banner, active) VALUES ($1,$2,$3,$4,$5)`, [
    id,
    title,
    body,
    input.banner,
    input.active,
  ]);
  await writeAudit(pool, actorId, "announcement", id, null, JSON.stringify({ title, body, banner: input.banner, active: input.active }));
  bustContentCache();
  return { id, title, body, banner: input.banner, active: input.active };
}

export async function contentAudit(pool: Db) {
  const rows = await pool.query(
    `SELECT id, actor_id, lang, key, old_value, new_value, created_at FROM content_audit ORDER BY id DESC LIMIT 40`,
  );
  return rows.rows;
}

export async function convertBps(pool: Db): Promise<{ fee: number; spread: number }> {
  const numbers = await loadNumbers(pool);
  return { fee: numbers["convert.feeBps"], spread: numbers["convert.spreadBps"] };
}

export async function redemptionFees(pool: Db, productId: string): Promise<{ fee: number; delivery: number }> {
  const numbers = await loadNumbers(pool);
  const fee = numbers[`redeem.${productId}.feeUsd`];
  const delivery = numbers[`redeem.${productId}.deliveryUsd`];
  if (fee == null || delivery == null) throw new PlatformError("VALIDATION");
  return { fee, delivery };
}

export async function redemptionCatalog(pool: Db) {
  const numbers = await loadNumbers(pool);
  return [
    { id: "coin_1oz", grams: 31.103, feeUsd: numbers["redeem.coin_1oz.feeUsd"], deliveryFeeUsd: numbers["redeem.coin_1oz.deliveryUsd"] },
    { id: "bar_100g", grams: 100, feeUsd: numbers["redeem.bar_100g.feeUsd"], deliveryFeeUsd: numbers["redeem.bar_100g.deliveryUsd"] },
    { id: "bar_1000g", grams: 1000, feeUsd: numbers["redeem.bar_1000g.feeUsd"], deliveryFeeUsd: numbers["redeem.bar_1000g.deliveryUsd"] },
  ];
}

/** Apply USD min/max/fee. 0 means no extra constraint and no fee. Returns the ledger amount. */
export async function adjustUsdMove(pool: Db, kind: "deposit" | "withdraw", amount: bigint): Promise<bigint> {
  const numbers = await loadNumbers(pool);
  const min = numbers[`${kind}.minUsd`];
  const max = numbers[`${kind}.maxUsd`];
  const fee = numbers[`${kind}.feeUsd`];
  const usd = Number(amount) / 1_000_000;
  if (min > 0 && usd + 1e-9 < min) throw new PlatformError("AMOUNT_LIMIT");
  if (max > 0 && usd - 1e-9 > max) throw new PlatformError("AMOUNT_LIMIT");
  const feeMicro = BigInt(Math.round(fee * 1_000_000));
  if (feeMicro <= 0n) return amount;
  if (kind === "deposit") {
    if (feeMicro >= amount) throw new PlatformError("AMOUNT_LIMIT");
    return amount - feeMicro;
  }
  return amount + feeMicro;
}
