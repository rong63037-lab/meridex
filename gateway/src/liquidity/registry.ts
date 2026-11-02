import type { Db } from "../db.js";
import { BinanceDemoFutures } from "./binanceDemo.js";
import { CoinbaseSandboxStub } from "./coinbaseSandbox.js";
import { FixSkeleton } from "./fix.js";
import { MockLiquidityProvider } from "./mock.js";
import { RestSkeleton } from "./rest.js";
import { SaxoSim } from "./saxoSim.js";
import type { LiquidityProvider, LpType, ProviderRow } from "./types.js";

const injected = new Map<number, LiquidityProvider>();
const mocks = new Map<number, MockLiquidityProvider>();

export function injectProvider(id: number, provider: LiquidityProvider | null) {
  if (provider) injected.set(id, provider);
  else injected.delete(id);
}

export function providerFor(row: ProviderRow): LiquidityProvider {
  const hit = injected.get(row.id);
  if (hit) return hit;
  if (row.type === "mock") {
    let mock = mocks.get(row.id);
    if (!mock) {
      mock = new MockLiquidityProvider(row.name);
      mocks.set(row.id, mock);
    }
    return mock;
  }
  if (row.name === "binance-demo") return new BinanceDemoFutures(row);
  if (row.name === "saxo-sim") return new SaxoSim(row);
  if (row.name === "coinbase-sandbox") return new CoinbaseSandboxStub();
  if (row.type === "fix") return new FixSkeleton(row);
  return new RestSkeleton(row);
}

export function resetProviderCache() {
  injected.clear();
  mocks.clear();
}

function mapOf(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

export function rowFrom(row: Record<string, unknown>): ProviderRow {
  return {
    id: Number(row.id),
    name: String(row.name),
    type: String(row.type) as LpType,
    baseUrl: String(row.base_url ?? ""),
    secretRef: String(row.secret_ref ?? ""),
    enabled: Boolean(row.enabled),
    mode: row.mode as ProviderRow["mode"],
    priority: Number(row.priority),
    spreadMarkupBps: Number(row.spread_markup_bps),
    minQty: BigInt(row.min_qty as string),
    maxQty: BigInt(row.max_qty as string),
    perOrderNotionalUusd: BigInt(row.per_order_notional_uusd as string),
    dailyNotionalUusd: BigInt(row.daily_notional_uusd as string),
    symbolMap: mapOf(row.symbol_map),
  };
}

export async function loadProviders(pool: Db): Promise<ProviderRow[]> {
  const rows = await pool.query(
    `SELECT id, name, type, base_url, secret_ref, enabled, mode, priority, spread_markup_bps,
            min_qty::text, max_qty::text, per_order_notional_uusd::text, daily_notional_uusd::text, symbol_map
     FROM lp_providers ORDER BY priority, id`,
  );
  return rows.rows.map((row) => rowFrom(row));
}

export async function loadProvider(pool: Db, id: number): Promise<ProviderRow | null> {
  const rows = await pool.query(
    `SELECT id, name, type, base_url, secret_ref, enabled, mode, priority, spread_markup_bps,
            min_qty::text, max_qty::text, per_order_notional_uusd::text, daily_notional_uusd::text, symbol_map
     FROM lp_providers WHERE id = $1`,
    [id],
  );
  return rows.rowCount ? rowFrom(rows.rows[0]) : null;
}
