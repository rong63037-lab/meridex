import type { Db } from "../db.js";
import { quoteNotional } from "../instruments.js";
import { raiseAlert } from "./alerts.js";
import { isHouseUser } from "./mark.js";
import { loadProviders, providerFor } from "./registry.js";
import { LpError, applyMarkup, mapSymbol, terminalZero, type PlaceResult, type ProviderRow, type Side, type Venue } from "./types.js";

export type Plan =
  | { kind: "internal" }
  | { kind: "shadow"; provider: ProviderRow }
  | { kind: "live"; provider: ProviderRow; failover: ProviderRow | null }
  | { kind: "killed" };

export async function killStopped(pool: Db): Promise<boolean> {
  const row = await pool.query(`SELECT stopped FROM lp_kill WHERE id = 1`);
  return Boolean(row.rows[0]?.stopped);
}

export async function planRoute(pool: Db, input: { venue: Venue; asset: string; userId: number }): Promise<Plan> {
  if (await isHouseUser(pool, input.userId)) return { kind: "internal" };
  const providers = await loadProviders(pool);
  const live = providers.filter((row) => row.enabled && row.mode === "live");
  const shadow = providers.filter((row) => row.enabled && row.mode === "shadow");
  const stopped = await killStopped(pool);
  if (live.length) {
    if (stopped) return { kind: "killed" };
    return { kind: "live", provider: live[0], failover: live[1] ?? null };
  }
  if (shadow.length && !stopped) return { kind: "shadow", provider: shadow[0] };
  return { kind: "internal" };
}

async function dailyUsed(pool: Db, providerId: number): Promise<bigint> {
  const row = await pool.query(
    `SELECT COALESCE(SUM(notional_uusd), 0)::text AS n
     FROM lp_routes
     WHERE provider_id = $1 AND sent AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')`,
    [providerId],
  );
  return BigInt((row.rows[0]?.n as string | undefined) ?? "0");
}

function assertCaps(row: ProviderRow, qty: bigint, notional: bigint, used: bigint) {
  if (row.perOrderNotionalUusd <= 0n || row.dailyNotionalUusd <= 0n) throw new LpError("LP_CAP");
  if (row.minQty > 0n && qty < row.minQty) throw new LpError("LP_CAP");
  if (row.maxQty > 0n && qty > row.maxQty) throw new LpError("LP_CAP");
  if (notional > row.perOrderNotionalUusd) throw new LpError("LP_CAP");
  if (used + notional > row.dailyNotionalUusd) throw new LpError("LP_CAP");
}

export type HedgeOrder = {
  userId: number;
  venue: Venue;
  asset: string;
  symbol: string;
  side: Side;
  qty: bigint;
  limitPx: bigint | null;
  notionalUusd: bigint;
  internalPx: bigint | null;
  qtyScale: number;
  priceScale: number;
  quoteScale: number;
};

export type HedgeOutcome = {
  clientOrderId: string;
  providerId: number;
  failoverProviderId: number | null;
  status: string;
  filledQty: bigint;
  avgPx: bigint;
  customerPx: bigint;
  sent: boolean;
};

async function placeOne(row: ProviderRow, req: { clientOrderId: string; symbol: string; side: Side; qty: bigint; price: bigint | null }, timeoutMs: number): Promise<{ result: PlaceResult; sent: boolean }> {
  const adapter = providerFor(row);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const result = await adapter.place(
      { clientOrderId: req.clientOrderId, symbol: req.symbol, side: req.side, qty: req.qty, price: req.price },
      ctrl.signal,
    );
    return { result, sent: true };
  } catch (err) {
    if (err instanceof LpError && (err.code === "LP_DOCS_REQUIRED" || err.code === "HOST_REFUSED" || err.code === "KEY_MISSING")) {
      return {
        sent: false,
        result: {
          clientOrderId: req.clientOrderId,
          providerOrderId: "",
          status: "rejected",
          filledQty: 0n,
          avgPx: 0n,
          fills: [],
          rejectReason: err.code,
        },
      };
    }
    return {
      sent: true,
      result: {
        clientOrderId: req.clientOrderId,
        providerOrderId: "",
        status: "timeout",
        filledQty: 0n,
        avgPx: 0n,
        fills: [],
        rejectReason: "TIMEOUT",
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

async function storeFills(pool: Db, providerId: number, clientOrderId: string, result: PlaceResult) {
  for (const fill of result.fills) {
    await pool.query(
      `INSERT INTO lp_fills (provider_id, fill_id, client_order_id, qty, px)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (provider_id, fill_id) DO NOTHING`,
      [providerId, fill.fillId, clientOrderId, fill.qty.toString(), fill.px.toString()],
    );
  }
}

export async function sendHedge(pool: Db, plan: Extract<Plan, { kind: "live" }>, order: HedgeOrder, timeoutMs = 3000): Promise<HedgeOutcome> {
  const clientOrderId = crypto.randomUUID();
  const mapped = mapSymbol(plan.provider, order.symbol);
  const quote = await providerFor(plan.provider).quote(mapped);
  const raw = order.side === "buy" ? quote?.ask ?? order.limitPx : quote?.bid ?? order.limitPx;
  const marked = raw && raw > 0n ? applyMarkup(raw, order.side, plan.provider.spreadMarkupBps) : order.notionalUusd > 0n ? order.limitPx : null;
  const capNotional = marked && marked > 0n
    ? quoteNotional(order.qty, marked, { qtyScale: order.qtyScale, priceScale: order.priceScale, quoteScale: order.quoteScale })
    : order.notionalUusd;
  assertCaps(plan.provider, order.qty, capNotional > 0n ? capNotional : order.notionalUusd, await dailyUsed(pool, plan.provider.id));
  if (order.limitPx && raw && ((order.side === "buy" && applyMarkup(raw, "buy", plan.provider.spreadMarkupBps) > order.limitPx) || (order.side === "sell" && applyMarkup(raw, "sell", plan.provider.spreadMarkupBps) < order.limitPx))) {
    throw new LpError("LP_REJECTED");
  }
  const first = await placeOne(plan.provider, { clientOrderId, symbol: mapped, side: order.side, qty: order.qty, price: raw ?? null }, timeoutMs);
  await storeFills(pool, plan.provider.id, clientOrderId, first.result);
  let chosen = first;
  let providerId = plan.provider.id;
  let failoverId: number | null = null;
  let failover = plan.failover;
  if (first.result.filledQty === 0n && terminalZero(first.result.status) && failover) {
    try {
      assertCaps(failover, order.qty, capNotional > 0n ? capNotional : order.notionalUusd, await dailyUsed(pool, failover.id));
    } catch {
      failover = null;
    }
  }
  if (first.result.filledQty === 0n && terminalZero(first.result.status) && failover) {
    const secondId = `${clientOrderId}#2`;
    const second = await placeOne(failover, {
      clientOrderId: secondId,
      symbol: mapSymbol(failover, order.symbol),
      side: order.side,
      qty: order.qty,
      price: raw ?? null,
    }, timeoutMs);
    await storeFills(pool, failover.id, clientOrderId, second.result);
    failoverId = failover.id;
    if (second.result.filledQty > 0n || !terminalZero(first.result.status)) {
      chosen = second;
      providerId = failover.id;
    } else {
      chosen = second;
      providerId = failover.id;
    }
  }
  const avg = chosen.result.avgPx;
  const customerPx = avg > 0n ? applyMarkup(avg, order.side, plan.provider.spreadMarkupBps) : 0n;
  const notional = customerPx > 0n
    ? quoteNotional(chosen.result.filledQty, customerPx, { qtyScale: order.qtyScale, priceScale: order.priceScale, quoteScale: order.quoteScale })
    : 0n;
  await pool.query(
    `INSERT INTO lp_routes (
       client_order_id, user_id, venue, mode, provider_id, failover_provider_id, asset, symbol, side, qty,
       intended_px, internal_px, external_px, filled_qty, notional_uusd, status, sent, detail
     ) VALUES ($1,$2,$3,'live',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)`,
    [
      clientOrderId,
      order.userId,
      order.venue,
      providerId,
      failoverId,
      order.asset,
      order.symbol,
      order.side,
      order.qty.toString(),
      raw?.toString() ?? null,
      order.internalPx?.toString() ?? null,
      avg > 0n ? avg.toString() : null,
      chosen.result.filledQty.toString(),
      notional.toString(),
      chosen.result.filledQty > 0n ? chosen.result.status : chosen.result.status,
      chosen.sent,
      JSON.stringify({ reason: chosen.result.rejectReason ?? null, primarySent: first.sent }),
    ],
  );
  if (chosen.sent && chosen.result.filledQty === 0n) await noteReject(pool, providerId);
  return {
    clientOrderId,
    providerId,
    failoverProviderId: failoverId,
    status: chosen.result.status,
    filledQty: chosen.result.filledQty,
    avgPx: avg,
    customerPx,
    sent: chosen.sent,
  };
}

async function noteReject(pool: Db, providerId: number) {
  const rows = await pool.query(
    `SELECT status FROM lp_routes
     WHERE provider_id = $1 AND sent AND created_at > now() - interval '1 hour'
     ORDER BY id DESC LIMIT 20`,
    [providerId],
  );
  const sample = rows.rowCount ?? 0;
  if (sample < 5) return;
  const bad = rows.rows.filter((row) => ["rejected", "timeout", "disconnected", "expired"].includes(String(row.status))).length;
  if (bad / sample >= 0.3) await raiseAlert(pool, "reject_spike", String(providerId), { bad, n: sample });
}

/** Shadow compares a quote with the internal fill. It must not call place. */
export async function logShadow(
  pool: Db,
  provider: ProviderRow,
  input: {
    userId: number;
    venue: Venue;
    asset: string;
    symbol: string;
    side: Side;
    qty: bigint;
    internalPx: bigint | null;
    filledQty: bigint;
    status: string;
  },
): Promise<void> {
  const adapter = providerFor(provider);
  const before = "placeCount" in adapter ? Number((adapter as { placeCount: number }).placeCount) : null;
  let intended: bigint | null = null;
  try {
    const quote = await adapter.quote(mapSymbol(provider, input.symbol));
    intended = input.side === "buy" ? quote?.ask ?? null : quote?.bid ?? null;
  } catch {
    intended = null;
  }
  if (before != null && "placeCount" in adapter && Number((adapter as { placeCount: number }).placeCount) !== before) {
    throw new LpError("SHADOW_SENT");
  }
  await pool.query(
    `INSERT INTO lp_routes (
       client_order_id, user_id, venue, mode, provider_id, asset, symbol, side, qty,
       intended_px, internal_px, filled_qty, status, sent
     ) VALUES ($1,$2,$3,'shadow',$4,$5,$6,$7,$8,$9,$10,$11,$12,false)`,
    [
      crypto.randomUUID(),
      input.userId,
      input.venue,
      provider.id,
      input.asset,
      input.symbol,
      input.side,
      input.qty.toString(),
      intended?.toString() ?? null,
      input.internalPx?.toString() ?? null,
      input.filledQty.toString(),
      input.status,
    ],
  );
}

export async function markHedgeUnapplied(pool: Db, clientOrderId: string) {
  await pool.query(`UPDATE lp_routes SET status = 'hedge_unapplied' WHERE client_order_id = $1`, [clientOrderId]);
  await raiseAlert(pool, "exposure", clientOrderId, { reason: "customer fill failed after a provider fill" });
}

export async function cancelHedge(pool: Db, providerId: number, clientOrderId: string) {
  const row = await loadProviders(pool);
  const provider = row.find((item) => item.id === providerId);
  if (!provider) return;
  try {
    await providerFor(provider).cancel(clientOrderId);
  } catch {
    /* a filled hedge cannot be unspoken; the alert remains */
  }
}

export async function checkExposure(pool: Db) {
  const rows = await pool.query(
    `SELECT asset,
            COALESCE(SUM(CASE WHEN side = 'buy' THEN filled_qty ELSE -filled_qty END), 0)::text AS routed
     FROM lp_routes WHERE sent AND filled_qty > 0 GROUP BY asset`,
  );
  const hedges = await pool.query(
    `SELECT r.asset,
            COALESCE(SUM(CASE WHEN r.side = 'buy' THEN f.qty ELSE -f.qty END), 0)::text AS hedged
     FROM lp_fills f JOIN lp_routes r ON r.client_order_id = f.client_order_id
     GROUP BY r.asset`,
  );
  const hedgeOf = new Map(hedges.rows.map((row) => [String(row.asset), BigInt(row.hedged as string)]));
  const caps = await pool.query(`SELECT asset, max_abs_qty::text FROM lp_exposure_caps`);
  const capOf = new Map(caps.rows.map((row) => [String(row.asset), BigInt(row.max_abs_qty as string)]));
  for (const row of rows.rows) {
    const asset = String(row.asset);
    const routed = BigInt(row.routed as string);
    const hedged = hedgeOf.get(asset) ?? 0n;
    const net = routed - hedged;
    const cap = capOf.get(asset) ?? 0n;
    const abs = net < 0n ? -net : net;
    if (cap > 0n && abs > cap) await raiseAlert(pool, "exposure", asset, { net: net.toString(), cap: cap.toString() });
  }
}

export async function exposureView(pool: Db) {
  const rows = await pool.query(
    `SELECT asset,
            COALESCE(SUM(CASE WHEN side = 'buy' THEN filled_qty ELSE -filled_qty END), 0)::text AS routed
     FROM lp_routes WHERE sent AND filled_qty > 0 GROUP BY asset`,
  );
  const hedges = await pool.query(
    `SELECT r.asset,
            COALESCE(SUM(CASE WHEN r.side = 'buy' THEN f.qty ELSE -f.qty END), 0)::text AS hedged
     FROM lp_fills f JOIN lp_routes r ON r.client_order_id = f.client_order_id
     GROUP BY r.asset`,
  );
  const caps = await pool.query(`SELECT asset, max_abs_qty::text AS n FROM lp_exposure_caps`);
  const hedgeOf = new Map(hedges.rows.map((row) => [String(row.asset), String(row.hedged)]));
  const capOf = new Map(caps.rows.map((row) => [String(row.asset), String(row.n)]));
  const assets = new Set<string>([...rows.rows.map((row) => String(row.asset)), ...hedgeOf.keys(), ...capOf.keys()]);
  return [...assets].map((asset) => {
    const routed = BigInt((rows.rows.find((row) => row.asset === asset)?.routed as string | undefined) ?? "0");
    const hedged = BigInt(hedgeOf.get(asset) ?? "0");
    return { asset, routedQty: routed.toString(), hedgeQty: hedged.toString(), netQty: (routed - hedged).toString(), capQty: capOf.get(asset) ?? "0" };
  });
}
