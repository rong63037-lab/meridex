import type { Db } from "./db.js";
import type { EngineClient } from "./engineClient.js";
import { getInstrument } from "./instruments.js";
import { formatScaled, parseScaled } from "./units.js";

export type AlertRow = {
  id: string;
  symbol: string;
  direction: "above" | "below";
  price: string;
  armed: boolean;
  triggeredAt: string | null;
};

function digits(scale: number): number {
  return Math.max(0, Math.round(Math.log10(scale)));
}

function showPrice(symbol: string, px: bigint): string {
  const inst = getInstrument(symbol);
  return formatScaled(px, digits(inst.priceScale), inst.priceDecimals);
}

export async function listAlerts(pool: Db, userId: number): Promise<AlertRow[]> {
  const rows = await pool.query(
    `SELECT id::text, symbol, direction, price_px::text, armed, triggered_at
     FROM price_alerts WHERE user_id = $1 ORDER BY id DESC LIMIT 40`,
    [userId],
  );
  return rows.rows.map((row) => ({
    id: row.id as string,
    symbol: row.symbol as string,
    direction: row.direction as "above" | "below",
    price: showPrice(row.symbol as string, BigInt(row.price_px as string)),
    armed: Boolean(row.armed),
    triggeredAt: row.triggered_at ? new Date(row.triggered_at as string).toISOString() : null,
  }));
}

export async function createAlert(pool: Db, userId: number, symbol: string, direction: "above" | "below", price: string): Promise<AlertRow> {
  const inst = getInstrument(symbol);
  const px = parseScaled(price, inst.priceDecimals);
  if (px <= 0n) throw new Error("VALIDATION");
  const row = await pool.query(
    `INSERT INTO price_alerts (user_id, symbol, direction, price_px)
     VALUES ($1,$2,$3,$4)
     RETURNING id::text, symbol, direction, price_px::text, armed, triggered_at`,
    [userId, inst.symbol, direction, px.toString()],
  );
  const saved = row.rows[0];
  return {
    id: saved.id as string,
    symbol: saved.symbol as string,
    direction: saved.direction as "above" | "below",
    price: showPrice(saved.symbol as string, BigInt(saved.price_px as string)),
    armed: true,
    triggeredAt: null,
  };
}

export async function deleteAlert(pool: Db, userId: number, id: string): Promise<boolean> {
  const row = await pool.query(`DELETE FROM price_alerts WHERE user_id = $1 AND id = $2`, [userId, id]);
  return (row.rowCount ?? 0) > 0;
}

export async function listNotices(pool: Db, userId: number) {
  const rows = await pool.query(
    `SELECT id::text, kind, symbol, direction, price_px::text, read_at, created_at
     FROM user_notices WHERE user_id = $1 ORDER BY id DESC LIMIT 40`,
    [userId],
  );
  return rows.rows.map((row) => ({
    id: row.id as string,
    kind: row.kind as string,
    symbol: row.symbol as string,
    direction: row.direction as "above" | "below",
    price: showPrice(row.symbol as string, BigInt(row.price_px as string)),
    read: row.read_at != null,
    createdAt: new Date(row.created_at as string).toISOString(),
  }));
}

export async function markNoticesRead(pool: Db, userId: number): Promise<void> {
  await pool.query(`UPDATE user_notices SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [userId]);
}

export async function listWatch(pool: Db, userId: number): Promise<string[]> {
  const rows = await pool.query(`SELECT symbol FROM watchlist WHERE user_id = $1 ORDER BY created_at`, [userId]);
  return rows.rows.map((row) => row.symbol as string);
}

export async function addWatch(pool: Db, userId: number, symbol: string): Promise<string[]> {
  const inst = getInstrument(symbol);
  await pool.query(
    `INSERT INTO watchlist (user_id, symbol) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [userId, inst.symbol],
  );
  return listWatch(pool, userId);
}

export async function removeWatch(pool: Db, userId: number, symbol: string): Promise<string[]> {
  await pool.query(`DELETE FROM watchlist WHERE user_id = $1 AND symbol = $2`, [userId, symbol]);
  return listWatch(pool, userId);
}

export function startAlertLoop(pool: Db, engine: EngineClient): void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const open = await pool.query(
        `SELECT id, user_id, symbol, direction, price_px::text AS price_px FROM price_alerts WHERE armed`,
      );
      if (!open.rowCount) return;
      const summaries = await engine.summaries();
      const lastBy = new Map(summaries.books.map((row) => [row.symbol, row.last_trade_price]));
      for (const row of open.rows) {
        const last = lastBy.get(row.symbol as string);
        if (last == null) continue;
        const target = BigInt(row.price_px as string);
        const px = BigInt(Math.round(last));
        const hit = row.direction === "above" ? px >= target : px <= target;
        if (!hit) continue;
        const fired = await pool.query(
          `UPDATE price_alerts SET armed = false, triggered_at = now() WHERE id = $1 AND armed RETURNING id`,
          [row.id],
        );
        if (!fired.rowCount) continue;
        await pool.query(
          `INSERT INTO user_notices (user_id, kind, symbol, direction, price_px) VALUES ($1,'price_alert',$2,$3,$4)`,
          [row.user_id, row.symbol, row.direction, row.price_px],
        );
        console.log(`alert fired user=${row.user_id} ${row.symbol} ${row.direction} ${row.price_px}`);
      }
    } catch (err) {
      console.error("alerts", err);
    } finally {
      running = false;
    }
  };
  setInterval(() => void tick(), 3000);
}
