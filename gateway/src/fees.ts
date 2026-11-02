import type { Db } from "./db.js";

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
};

const SPOT_NAMES = ["standard", "silver", "gold", "private", "spot4"] as const;

export function feeOf(notional: bigint, bps: number): bigint {
  if (bps <= 0 || notional <= 0n) return 0n;
  return (notional * BigInt(Math.trunc(bps))) / 10_000n;
}

export function parseFeeKey(key: string): { product: "spot" | "perp"; tier: number; field: "maker" | "taker" | "min" } | null {
  const spot = key.match(/^fee\.(standard|silver|gold|private|spot4)\.(makerBps|takerBps|minUsd)$/);
  if (spot) {
    const tier = SPOT_NAMES.indexOf(spot[1] as (typeof SPOT_NAMES)[number]);
    const field = spot[2] === "makerBps" ? "maker" : spot[2] === "takerBps" ? "taker" : "min";
    return { product: "spot", tier, field };
  }
  const perp = key.match(/^fee\.(perp[0-4])\.(makerBps|takerBps|minUsd)$/);
  if (perp) {
    const field = perp[2] === "makerBps" ? "maker" : perp[2] === "takerBps" ? "taker" : "min";
    return { product: "perp", tier: Number(perp[1].slice(4)), field };
  }
  return null;
}

export function overlayFeeNumbers(
  values: Record<string, number>,
  rows: { product: string; tier: number; min_volume_uusd: string; maker_bps: number; taker_bps: number }[],
) {
  for (const row of rows) {
    const tier = Number(row.tier);
    const label = row.product === "spot" ? SPOT_NAMES[tier] : row.product === "perp" ? `perp${tier}` : "";
    if (!label) continue;
    const makerKey = `fee.${label}.makerBps`;
    const takerKey = `fee.${label}.takerBps`;
    if (Object.prototype.hasOwnProperty.call(values, makerKey)) values[makerKey] = Number(row.maker_bps);
    if (Object.prototype.hasOwnProperty.call(values, takerKey)) values[takerKey] = Number(row.taker_bps);
    if (tier > 0) {
      const minKey = `fee.${label}.minUsd`;
      if (Object.prototype.hasOwnProperty.call(values, minKey)) {
        values[minKey] = Number(BigInt(row.min_volume_uusd) / 1_000_000n);
      }
    }
  }
}

export async function tierBps(db: Queryable, userId: number, product: "spot" | "perp") {
  const volume = product === "perp"
    ? await db.query(
        `SELECT COALESCE(SUM(notional_uusd),0)::text AS n
         FROM real_fills
         WHERE user_id = $1 AND product = 'perp' AND kind IN ('open','close','liquidation')
           AND created_at > now() - interval '30 days'`,
        [userId],
      )
    : await db.query(
        `SELECT (
           COALESCE((SELECT SUM(notional_uusd) FROM trades
                     WHERE (buyer_id = $1 OR seller_id = $1) AND tape_at > now() - interval '30 days'), 0)
           + COALESCE((SELECT SUM(notional_uusd) FROM real_fills
                       WHERE user_id = $1 AND product = 'margin' AND kind IN ('open','close','liquidation')
                         AND created_at > now() - interval '30 days'), 0)
         )::text AS n`,
        [userId],
      );
  const vol = BigInt(String(volume.rows[0]?.n ?? "0"));
  const rows = await db.query(
    `SELECT tier, min_volume_uusd::text, maker_bps, taker_bps FROM fee_tiers WHERE product = $1 ORDER BY tier`,
    [product],
  );
  let tier = 0;
  let maker = product === "perp" ? 2 : 10;
  let taker = product === "perp" ? 5 : 10;
  for (const row of rows.rows) {
    if (vol >= BigInt(String(row.min_volume_uusd))) {
      tier = Number(row.tier);
      maker = Number(row.maker_bps);
      taker = Number(row.taker_bps);
    }
  }
  return { tier, maker, taker, volumeUusd: vol.toString() };
}

export async function houseBot(db: Queryable, email: string) {
  const row = await db.query(
    `SELECT id, entity_id, jurisdiction FROM users WHERE email = $1 AND role = 'bot'`,
    [email],
  );
  if (!row.rowCount || !row.rows[0]?.entity_id) return null;
  return {
    id: Number(row.rows[0].id),
    entityId: String(row.rows[0].entity_id),
    jurisdiction: String(row.rows[0].jurisdiction || "SG"),
  };
}

export async function writeFeeKey(pool: Db, key: string, value: number) {
  const parsed = parseFeeKey(key);
  if (!parsed) return false;
  const current = await pool.query(
    `SELECT maker_bps, taker_bps, min_volume_uusd::text FROM fee_tiers WHERE product = $1 AND tier = $2`,
    [parsed.product, parsed.tier],
  );
  if (!current.rowCount) return false;
  let maker = Number(current.rows[0].maker_bps);
  let taker = Number(current.rows[0].taker_bps);
  let min = BigInt(String(current.rows[0].min_volume_uusd));
  if (parsed.field === "maker") maker = value;
  else if (parsed.field === "taker") taker = value;
  else min = BigInt(value) * 1_000_000n;
  await pool.query(
    `UPDATE fee_tiers SET maker_bps = $3, taker_bps = $4, min_volume_uusd = $5 WHERE product = $1 AND tier = $2`,
    [parsed.product, parsed.tier, maker, taker, min.toString()],
  );
  if (parsed.product === "spot" && parsed.tier <= 3) {
    const name = SPOT_NAMES[parsed.tier];
    await pool.query(
      `INSERT INTO fee_schedules (vip_tier, maker_bps, taker_bps) VALUES ($1,$2,$3)
       ON CONFLICT (vip_tier) DO UPDATE SET maker_bps = EXCLUDED.maker_bps, taker_bps = EXCLUDED.taker_bps, updated_at = now()`,
      [name, maker, taker],
    );
    if (parsed.field === "min") {
      await pool.query(`UPDATE vip_tiers SET min_volume_uusd = $2, maker_bps = $3, taker_bps = $4 WHERE id = $1`, [
        name,
        min.toString(),
        maker,
        taker,
      ]);
    } else {
      await pool.query(`UPDATE vip_tiers SET maker_bps = $2, taker_bps = $3 WHERE id = $1`, [name, maker, taker]);
    }
  }
  return true;
}

/** Maker-checker fee_schedule still names standard/silver/gold/private. Keep the tier row in step. */
export async function setNamedSpotFee(pool: Db, tier: string, maker: number, taker: number) {
  await pool.query(
    `INSERT INTO fee_schedules (vip_tier, maker_bps, taker_bps) VALUES ($1,$2,$3)
     ON CONFLICT (vip_tier) DO UPDATE SET maker_bps = EXCLUDED.maker_bps, taker_bps = EXCLUDED.taker_bps, updated_at = now()`,
    [tier, maker, taker],
  );
  await pool.query(`UPDATE vip_tiers SET maker_bps = $2, taker_bps = $3 WHERE id = $1`, [tier, maker, taker]);
  const idx = SPOT_NAMES.indexOf(tier as (typeof SPOT_NAMES)[number]);
  if (idx >= 0 && idx <= 3) {
    await pool.query(`UPDATE fee_tiers SET maker_bps = $2, taker_bps = $3 WHERE product = 'spot' AND tier = $1`, [idx, maker, taker]);
  }
}

export async function feeView(pool: Db, userId: number | null) {
  const rows = await pool.query(
    `SELECT product, tier, min_volume_uusd::text, maker_bps, taker_bps FROM fee_tiers ORDER BY product, tier`,
  );
  const tiers = rows.rows.map((row) => ({
    product: String(row.product),
    tier: Number(row.tier),
    min_volume_uusd: String(row.min_volume_uusd),
    maker_bps: Number(row.maker_bps),
    taker_bps: Number(row.taker_bps),
  }));
  const spot = userId ? await tierBps(pool, userId, "spot") : null;
  const perp = userId ? await tierBps(pool, userId, "perp") : null;
  return { tiers, spot, perp, margin: "spot" as const };
}
