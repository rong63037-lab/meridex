import type pg from "pg";
import type { Db } from "./db.js";
import { withTx } from "./db.js";
import type { EngineClient, EngineEvent } from "./engineClient.js";
import {
  finishOrder,
  LedgerError,
  markOpen,
  reserveOrder,
  coverHold,
  settleTrade,
  type CustomerRef,
} from "./ledger.js";
import { getInstrument, quoteNotional, type Instrument } from "./instruments.js";
import { liveSpot, rememberShadow, spotPlan } from "./liquidity/spotRoute.js";
import type { Venue } from "./liquidity/types.js";

let gate: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = gate.then(fn, fn);
  gate = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export type EngineOrderType = "limit" | "market" | "ioc" | "fok" | "post_only";
export type OrderType = EngineOrderType | "stop_limit" | "oco";

export type OrderInput = {
  side: "buy" | "sell";
  orderType: OrderType;
  priceCents: bigint | null;
  qtyMg: bigint;
  stopPriceCents?: bigint | null;
  stopLimitCents?: bigint | null;
  groupId?: string | null;
  symbol?: string;
  lpVenue?: Venue;
};

function bookOf(input: { symbol?: string | null }): Instrument {
  return getInstrument(input.symbol || "XAU/USD");
}

function holdMeta(inst: Instrument) {
  return {
    symbol: inst.symbol,
    baseAsset: inst.base,
    quoteAsset: inst.quote,
    qtyScale: BigInt(inst.qtyScale),
    priceScale: BigInt(inst.priceScale),
    quoteScale: BigInt(inst.quoteScale),
  };
}

function onTick(price: bigint, inst: Instrument): boolean {
  const tick = BigInt(inst.tickSize);
  return tick <= 1n || price % tick === 0n;
}

export type OrderResponse = {
  orderId: string;
  status: string;
  rejectReason: string | null;
  filledMg: string;
  leavesMg: string;
  trades: { price: number; qty: number; tradeId: string }[];
  lpExternal?: boolean;
};

function mapReject(reason: string | null): string {
  if (!reason) return "REJECTED";
  if (reason === "SELF_TRADE") return "SELF_TRADE";
  if (reason === "PRICE_BAND") return "PRICE_BAND";
  if (reason === "MARKET_HALTED" || reason === "CIRCUIT_BREAKER") return reason;
  if (reason === "POST_ONLY") return "POST_ONLY";
  if (reason === "FOK_UNFILLABLE") return "FOK_UNFILLABLE";
  if (reason === "INSUFFICIENT_BALANCE") return "INSUFFICIENT_FUNDS";
  return reason;
}

type Health = {
  halted: boolean;
  band_high: number;
  band_low: number;
  reference_price: number;
  last_trade_price: number | null;
};

function inBand(price: bigint, health: Health): boolean {
  return price >= BigInt(health.band_low) && price <= BigInt(health.band_high);
}

function triggered(side: "buy" | "sell", stop: bigint, last: number): boolean {
  return side === "buy" ? last >= Number(stop) : last <= Number(stop);
}

export async function placeOrder(
  pool: Db,
  engine: EngineClient,
  user: CustomerRef,
  input: OrderInput,
): Promise<OrderResponse> {
  return serialize(() => placeOrderLocked(pool, engine, user, input));
}

async function placeOrderLocked(
  pool: Db,
  engine: EngineClient,
  user: CustomerRef,
  input: OrderInput,
): Promise<OrderResponse> {
  const inst = bookOf(input);
  if (inst.status !== "trading") throw new LedgerError("MARKET_HALTED");
  const health = await engine.health(inst.symbol);
  if (health.halted) throw new LedgerError("MARKET_HALTED");
  if (input.qtyMg <= 0n || input.qtyMg < BigInt(inst.minQty)) throw new LedgerError("VALIDATION");
  if (input.priceCents !== null && !onTick(input.priceCents, inst)) throw new LedgerError("TICK");
  if (input.stopPriceCents != null && !onTick(input.stopPriceCents, inst)) throw new LedgerError("TICK");

  const plan = await spotPlan(pool, user.id, input.lpVenue ?? "spot", inst.base);
  if (plan.kind === "killed") throw new LedgerError("LP_KILLED");
  if (plan.kind === "live" && (input.orderType === "stop_limit" || input.orderType === "oco" || input.orderType === "limit" || input.orderType === "post_only")) {
    throw new LedgerError("LP_RESTING");
  }
  if (plan.kind === "live") {
    return liveSpot(pool, user, inst, {
      side: input.side,
      orderType: input.orderType,
      priceCents: input.priceCents,
      qty: input.qtyMg,
      venue: input.lpVenue ?? "spot",
    });
  }

  if (input.orderType === "stop_limit" || input.orderType === "oco") {
    if (input.priceCents === null || input.stopPriceCents == null) throw new LedgerError("VALIDATION");
    if (!inBand(input.priceCents, health) || !inBand(input.stopPriceCents, health)) throw new LedgerError("PRICE_BAND");
    const last = health.last_trade_price ?? health.reference_price;
    if (input.orderType === "stop_limit") {
      if (input.side === "buy" && input.priceCents < input.stopPriceCents) throw new LedgerError("STOP_PRICE");
      if (input.side === "sell" && input.priceCents > input.stopPriceCents) throw new LedgerError("STOP_PRICE");
      if (!inBand(input.priceCents, health)) throw new LedgerError("PRICE_BAND");
      return armStop(pool, engine, user, input, health, last);
    }
    const stopLimit = input.stopLimitCents ?? input.stopPriceCents;
    if (!inBand(stopLimit, health)) throw new LedgerError("PRICE_BAND");
    if (input.side === "sell") {
      if (!(input.priceCents > BigInt(last) && input.stopPriceCents < BigInt(last))) throw new LedgerError("OCO_PRICE");
      if (stopLimit > input.stopPriceCents) throw new LedgerError("OCO_PRICE");
    } else {
      if (!(input.priceCents < BigInt(last) && input.stopPriceCents > BigInt(last))) throw new LedgerError("OCO_PRICE");
      if (stopLimit < input.stopPriceCents) throw new LedgerError("OCO_PRICE");
    }
    const placed = await submitEngine(pool, engine, user, { ...input, orderType: "limit" }, health);
    if (placed.status === "open" || placed.status === "filled") {
      const group = input.groupId ?? crypto.randomUUID();
      await pool.query(
        `UPDATE user_orders
         SET order_type = 'oco', stop_price_cents = $2, stop_limit_cents = $3, group_id = $4, updated_at = now()
         WHERE engine_order_id = $1`,
        [placed.orderId, input.stopPriceCents.toString(), stopLimit.toString(), group],
      );
    }
    return placed;
  }

  const placed = await submitEngine(pool, engine, user, input, health);
  if (plan.kind === "shadow") {
    const avg = averageTradePx(placed.trades);
    await rememberShadow(pool, plan, {
      userId: user.id,
      venue: input.lpVenue ?? "spot",
      asset: inst.base,
      symbol: inst.symbol,
      side: input.side,
      qty: input.qtyMg,
      internalPx: avg,
      filledQty: BigInt(placed.filledMg || "0"),
      status: placed.status,
    });
  }
  return placed;
}

function averageTradePx(trades: { price: number; qty: number }[]): bigint | null {
  let qty = 0n;
  let notion = 0n;
  for (const leg of trades) {
    const q = BigInt(Math.round(leg.qty));
    if (q <= 0n) continue;
    qty += q;
    notion += q * BigInt(Math.round(leg.price));
  }
  return qty > 0n ? notion / qty : null;
}

async function armStop(
  pool: Db,
  engine: EngineClient,
  user: CustomerRef,
  input: OrderInput,
  health: Health,
  last: number,
): Promise<OrderResponse> {
  const stop = input.stopPriceCents!;
  const limit = input.priceCents!;
  if (triggered(input.side, stop, last)) {
    return submitEngine(pool, engine, user, { ...input, orderType: "limit", priceCents: limit }, health);
  }
  const inst = bookOf(input);
  const orderId = crypto.randomUUID();
  const reserveUusd = input.side === "buy" ? quoteNotional(input.qtyMg, limit, inst) : 0n;
  const reserveMg = input.side === "sell" ? input.qtyMg : 0n;
  try {
    await withTx(pool, (client) =>
      reserveOrder(client, user, {
        orderId,
        side: input.side,
        orderType: "stop_limit",
        priceCents: limit,
        qtyMg: input.qtyMg,
        reserveUusd,
        reserveMg,
        ...holdMeta(inst),
      }),
    );
  } catch (err) {
    if (err instanceof LedgerError && err.code === "INSUFFICIENT_BALANCE") {
      throw new LedgerError(input.side === "buy" || inst.base !== "XAU" ? "INSUFFICIENT_FUNDS" : "INSUFFICIENT_GOLD");
    }
    throw err;
  }
  await pool.query(
    `UPDATE order_holds SET status = 'armed', updated_at = now() WHERE engine_order_id = $1`,
    [orderId],
  );
  await pool.query(
    `UPDATE user_orders
     SET status = 'armed', stop_price_cents = $2, group_id = $3, updated_at = now()
     WHERE engine_order_id = $1`,
    [orderId, stop.toString(), input.groupId ?? crypto.randomUUID()],
  );
  return readOrder(pool, orderId, []);
}

async function submitEngine(
  pool: Db,
  engine: EngineClient,
  user: CustomerRef,
  input: OrderInput,
  health: Health,
): Promise<OrderResponse> {
  const inst = bookOf(input);
  const isMarket = input.orderType === "market";
  const engineType: EngineOrderType = input.orderType === "oco" || input.orderType === "stop_limit" ? "limit" : input.orderType;
  const protection = input.side === "buy" ? BigInt(health.band_high) : BigInt(health.band_low);
  const reservePrice = isMarket ? protection : input.priceCents;
  if (!isMarket && (input.priceCents === null || input.priceCents <= 0n)) throw new LedgerError("VALIDATION");
  const reserveUusd = input.side === "buy" ? quoteNotional(input.qtyMg, reservePrice!, inst) : 0n;
  const reserveMg = input.side === "sell" ? input.qtyMg : 0n;
  const orderId = crypto.randomUUID();
  try {
    await withTx(pool, (client) =>
      reserveOrder(client, user, {
        orderId,
        side: input.side,
        orderType: input.orderType === "limit" ? engineType : input.orderType,
        priceCents: reservePrice,
        qtyMg: input.qtyMg,
        reserveUusd,
        reserveMg,
        ...holdMeta(inst),
      }),
    );
  } catch (err) {
    if (err instanceof LedgerError && err.code === "INSUFFICIENT_BALANCE") {
      throw new LedgerError(input.side === "buy" || inst.base !== "XAU" ? "INSUFFICIENT_FUNDS" : "INSUFFICIENT_GOLD");
    }
    throw err;
  }
  if (input.groupId) {
    await pool.query(`UPDATE user_orders SET group_id = $2 WHERE engine_order_id = $1`, [orderId, input.groupId]);
  }

  let result;
  try {
    result = await engine.command({
      type: "new_order",
      order_id: orderId,
      user_id: user.id,
      side: input.side,
      order_type: engineType,
      price: isMarket ? null : Number(input.priceCents),
      qty: Number(input.qtyMg),
      protection_price: isMarket ? Number(protection) : null,
      expected_ref: health.reference_price,
    }, inst.symbol);
  } catch (err) {
    await withTx(pool, (client) => finishOrder(client, orderId, "rejected", "ENGINE_UNAVAILABLE", true));
    throw err;
  }
  await applyEvents(pool, orderId, result.events);
  return readOrder(pool, orderId, result.events);
}

export async function cancelOrder(pool: Db, engine: EngineClient, user: CustomerRef, orderId: string): Promise<OrderResponse> {
  return serialize(() => cancelOrderLocked(pool, engine, user, orderId));
}

async function cancelOrderLocked(pool: Db, engine: EngineClient, user: CustomerRef, orderId: string): Promise<OrderResponse> {
  const owned = await pool.query(`SELECT user_id, status, symbol FROM user_orders WHERE engine_order_id = $1`, [orderId]);
  if (!owned.rowCount || Number(owned.rows[0].user_id) !== user.id) throw new LedgerError("NOT_FOUND");
  const symbol = (owned.rows[0].symbol as string | null) ?? "XAU/USD";
  if (owned.rows[0].status === "armed") {
    await withTx(pool, (client) => finishOrder(client, orderId, "canceled", "CANCELED", true));
    return readOrder(pool, orderId, []);
  }
  const result = await engine.command({ type: "cancel", order_id: orderId, user_id: user.id }, symbol);
  const rejected = result.events.find((e) => e.type === "rejected");
  if (rejected) throw new LedgerError(rejected.reason ?? "NOT_FOUND");
  await applyEvents(pool, orderId, result.events);
  return readOrder(pool, orderId, result.events);
}

export async function cancelAll(pool: Db, engine: EngineClient, user: CustomerRef): Promise<{ canceled: string[] }> {
  return serialize(async () => {
    const rows = await pool.query(
      `SELECT engine_order_id FROM user_orders WHERE user_id = $1 AND status IN ('open', 'armed') ORDER BY created_at`,
      [user.id],
    );
    const canceled: string[] = [];
    for (const row of rows.rows) {
      try {
        await cancelOrderLocked(pool, engine, user, row.engine_order_id as string);
        canceled.push(row.engine_order_id as string);
      } catch {
        // A fill can land between the list and the cancel.
      }
    }
    return { canceled };
  });
}

export async function amendOrder(
  pool: Db,
  engine: EngineClient,
  user: CustomerRef,
  orderId: string,
  priceCents: bigint,
  qtyMg: bigint,
): Promise<OrderResponse> {
  return serialize(async () => {
    const owned = await pool.query(`SELECT * FROM user_orders WHERE engine_order_id = $1`, [orderId]);
    if (!owned.rowCount || Number(owned.rows[0].user_id) !== user.id) throw new LedgerError("NOT_FOUND");
    const row = owned.rows[0];
    if (row.status === "armed" && row.order_type === "stop_limit") {
      await cancelOrderLocked(pool, engine, user, orderId);
      return placeOrderLocked(pool, engine, user, {
        side: row.side,
        orderType: "stop_limit",
        priceCents,
        qtyMg,
        stopPriceCents: BigInt(row.stop_price_cents),
        groupId: row.group_id,
        symbol: row.symbol ?? "XAU/USD",
      });
    }
    if (row.status === "open" && (row.order_type === "limit" || row.order_type === "post_only" || row.order_type === "oco")) {
      const type = row.order_type as OrderType;
      await cancelOrderLocked(pool, engine, user, orderId);
      return placeOrderLocked(pool, engine, user, {
        side: row.side,
        orderType: type,
        priceCents,
        qtyMg,
        stopPriceCents: row.stop_price_cents ? BigInt(row.stop_price_cents) : null,
        stopLimitCents: row.stop_limit_cents ? BigInt(row.stop_limit_cents) : null,
        groupId: row.group_id,
        symbol: row.symbol ?? "XAU/USD",
      });
    }
    throw new LedgerError("NOT_AMENDABLE");
  });
}

export async function scanTriggers(
  pool: Db,
  engine: EngineClient,
  symbol: string,
  lastCents: number | null,
  halted: boolean,
): Promise<boolean> {
  if (halted || lastCents === null) return false;
  const rows = await pool.query(
    `SELECT engine_order_id, side, order_type, stop_price_cents, status
     FROM user_orders
     WHERE symbol = $1
       AND ((status = 'armed' AND order_type = 'stop_limit')
        OR (status = 'open' AND order_type = 'oco' AND stop_price_cents IS NOT NULL))`,
    [symbol],
  );
  let fired = false;
  for (const row of rows.rows) {
    const stop = Number(row.stop_price_cents);
    if (!Number.isFinite(stop)) continue;
    const hit = row.side === "buy" ? lastCents >= stop : lastCents <= stop;
    if (!hit) continue;
    if (row.order_type === "stop_limit") {
      await serialize(() => fireStopLocked(pool, engine, row.engine_order_id as string));
    } else {
      await serialize(() => fireOcoLocked(pool, engine, row.engine_order_id as string));
    }
    fired = true;
  }
  return fired;
}

async function fireStopLocked(pool: Db, engine: EngineClient, orderId: string): Promise<void> {
  const row = await pool.query(`SELECT * FROM user_orders WHERE engine_order_id = $1`, [orderId]);
  if (!row.rowCount || row.rows[0].status !== "armed") return;
  const order = row.rows[0];
  const marked = await pool.query(
    `UPDATE user_orders SET status = 'pending', updated_at = now() WHERE engine_order_id = $1 AND status = 'armed' RETURNING engine_order_id`,
    [orderId],
  );
  if (!marked.rowCount) return;
  await pool.query(`UPDATE order_holds SET status = 'pending', updated_at = now() WHERE engine_order_id = $1`, [orderId]);
  const symbol = (order.symbol as string | null) ?? "XAU/USD";
  const health = await engine.health(symbol);
  if (health.halted) {
    await withTx(pool, (client) => finishOrder(client, orderId, "rejected", "MARKET_HALTED", true));
    return;
  }
  let result;
  try {
    result = await engine.command({
      type: "new_order",
      order_id: orderId,
      user_id: Number(order.user_id),
      side: order.side,
      order_type: "limit",
      price: Number(order.price_cents),
      qty: Number(order.leaves_mg),
      protection_price: null,
      expected_ref: health.reference_price,
    }, symbol);
  } catch (err) {
    await withTx(pool, (client) => finishOrder(client, orderId, "rejected", "ENGINE_UNAVAILABLE", true));
    throw err;
  }
  await applyEvents(pool, orderId, result.events);
}

async function fireOcoLocked(pool: Db, engine: EngineClient, orderId: string): Promise<void> {
  const row = await pool.query(`SELECT * FROM user_orders WHERE engine_order_id = $1`, [orderId]);
  if (!row.rowCount || row.rows[0].status !== "open" || row.rows[0].order_type !== "oco") return;
  const order = row.rows[0];
  const user = await loadCustomer(pool, Number(order.user_id));
  if (!user) return;
  try {
    await cancelOrderLocked(pool, engine, user, orderId);
  } catch {
    return;
  }
  const after = await pool.query(`SELECT status, leaves_mg FROM user_orders WHERE engine_order_id = $1`, [orderId]);
  if (after.rows[0]?.status !== "canceled") return;
  const qty = BigInt(after.rows[0].leaves_mg);
  if (qty <= 0n) return;
  await placeOrderLocked(pool, engine, user, {
    side: order.side,
    orderType: "limit",
    priceCents: BigInt(order.stop_limit_cents),
    qtyMg: qty,
    groupId: order.group_id,
    symbol: order.symbol ?? "XAU/USD",
  });
}

export async function applyEvents(pool: Db, orderId: string, events: EngineEvent[]): Promise<void> {
  await withTx(pool, async (client) => {
    const current = await client.query(`SELECT status FROM order_holds WHERE engine_order_id = $1 FOR UPDATE`, [orderId]);
    if (!current.rowCount) throw new LedgerError("HOLD_MISSING");
    const status = current.rows[0].status as string;
    if (!["pending", "open"].includes(status)) return;

    const rejected = events.find((e) => e.type === "rejected" && e.order_id === orderId);
    if (rejected) {
      await finishOrder(client, orderId, "rejected", rejected.reason ?? "REJECTED", true);
      return;
    }
    for (const event of events) {
      if (event.type !== "trade") continue;
      await settleTrade(client, {
        tradeId: String(event.trade_id),
        priceCents: BigInt(event.price ?? 0),
        qtyMg: BigInt(event.qty ?? 0),
        buyerOrderId: event.buyer_order_id!,
        sellerOrderId: event.seller_order_id!,
        takerOrderId: event.taker_order_id!,
        makerOrderId: event.maker_order_id!,
        takerSide: event.taker_side ?? "buy",
      });
      for (const id of [event.buyer_order_id!, event.seller_order_id!]) {
        await client.query(
          `UPDATE order_holds SET status = 'filled', updated_at = now()
           WHERE engine_order_id = $1 AND leaves_mg = 0 AND status IN ('pending','open')`,
          [id],
        );
        await client.query(
          `UPDATE user_orders SET status = 'filled', updated_at = now()
           WHERE engine_order_id = $1 AND leaves_mg = 0 AND status IN ('pending','open')`,
          [id],
        );
      }
    }
    const canceled = events.find((e) => e.type === "canceled" && e.order_id === orderId);
    const resting = events.find((e) => e.type === "resting" && e.order_id === orderId);
    if (canceled) {
      await finishOrder(client, orderId, "canceled", canceled.reason ?? "CANCELED", true);
      return;
    }
    if (resting) {
      await markOpen(client, orderId);
      return;
    }
    const still = await client.query(`SELECT status, leaves_mg::text AS leaves_mg FROM order_holds WHERE engine_order_id = $1`, [orderId]);
    if (still.rows[0].status === "pending") {
      if (BigInt(still.rows[0].leaves_mg) === 0n) await finishOrder(client, orderId, "filled", null, false);
      else await markOpen(client, orderId);
    }
  });
}

async function readOrder(pool: Db, orderId: string, events: EngineEvent[]): Promise<OrderResponse> {
  const row = await pool.query(`SELECT * FROM user_orders WHERE engine_order_id = $1`, [orderId]);
  const order = row.rows[0];
  return {
    orderId,
    status: order?.status ?? "unknown",
    rejectReason: order?.reject_reason ? mapReject(order.reject_reason) : null,
    filledMg: String(order?.filled_mg ?? "0"),
    leavesMg: String(order?.leaves_mg ?? "0"),
    trades: events
      .filter((e) => e.type === "trade")
      .map((e) => ({ price: e.price ?? 0, qty: e.qty ?? 0, tradeId: String(e.trade_id) })),
  };
}

/** Book trade ids restart at 1, so an earlier build skipped non-gold prints that collided with XAU. Post them now. */
export async function repairUnsettledTrades(pool: Db, engine: EngineClient): Promise<number> {
  const rows = await pool.query(
    `SELECT engine_order_id, symbol FROM user_orders WHERE symbol <> 'XAU/USD' AND status = 'filled' AND filled_mg = 0`,
  );
  const seen = new Set<string>();
  let posted = 0;
  for (const row of rows.rows) {
    const symbol = row.symbol as string;
    const view = await engine.order(row.engine_order_id as string, symbol);
    for (const event of view.events) {
      if (event.type !== "trade" || event.trade_id === undefined) continue;
      const key = `${symbol}:${event.trade_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const wrote = await withTx(pool, async (client) => {
          const dup = await client.query(`SELECT 1 FROM trades WHERE symbol = $1 AND engine_trade_id = $2`, [symbol, String(event.trade_id)]);
          if (dup.rowCount) return false;
          const qty = BigInt(event.qty ?? 0);
          const buyer = await client.query(
            `SELECT price_cents::text, qty_scale::text, price_scale::text, quote_scale::text FROM order_holds WHERE engine_order_id = $1`,
            [event.buyer_order_id],
          );
          if (!buyer.rowCount || !buyer.rows[0].price_cents) throw new LedgerError("HOLD_MISSING");
          const limit = BigInt(buyer.rows[0].price_cents);
          const slice = (qty * limit * BigInt(buyer.rows[0].quote_scale)) / (BigInt(buyer.rows[0].qty_scale) * BigInt(buyer.rows[0].price_scale));
          await coverHold(client, event.buyer_order_id!, slice, 0n);
          await coverHold(client, event.seller_order_id!, 0n, qty);
          await settleTrade(client, {
            tradeId: String(event.trade_id),
            priceCents: BigInt(event.price ?? 0),
            qtyMg: qty,
            buyerOrderId: event.buyer_order_id!,
            sellerOrderId: event.seller_order_id!,
            takerOrderId: event.taker_order_id!,
            makerOrderId: event.maker_order_id!,
            takerSide: event.taker_side ?? "buy",
          });
          await client.query(
            `UPDATE order_holds SET status = 'filled', updated_at = now() WHERE engine_order_id = ANY($1::text[]) AND leaves_mg = 0`,
            [[event.buyer_order_id, event.seller_order_id]],
          );
          await client.query(
            `UPDATE user_orders SET status = 'filled', updated_at = now() WHERE engine_order_id = ANY($1::text[]) AND leaves_mg = 0`,
            [[event.buyer_order_id, event.seller_order_id]],
          );
          return true;
        });
        if (wrote) posted += 1;
      } catch (err) {
        console.error("repair trade", key, err);
      }
    }
  }
  if (posted) console.log(`repaired unsettled trades=${posted}`);
  return posted;
}

export async function recoverPending(pool: Db, engine: EngineClient): Promise<number> {
  const pending = await pool.query(
    `SELECT engine_order_id, symbol FROM order_holds WHERE status = 'pending' ORDER BY created_at`,
  );
  let n = 0;
  for (const row of pending.rows) {
    const id = row.engine_order_id as string;
    const symbol = (row.symbol as string | null) ?? "XAU/USD";
    await serialize(async () => {
      const view = await engine.order(id, symbol);
      if (!view.found) {
        await withTx(pool, (client) => finishOrder(client, id, "rejected", "RECOVERY_NOT_SENT", true));
      } else {
        try {
          await applyEvents(pool, id, view.events);
        } catch (err) {
          console.error("recoverPending skipped order", id, err);
        }
      }
      n += 1;
    });
  }
  return n;
}

export async function loadCustomer(pool: pg.Pool, userId: number): Promise<CustomerRef | null> {
  const row = await pool.query(
    `SELECT id, entity_id, jurisdiction FROM users WHERE id = $1 AND entity_id IS NOT NULL AND jurisdiction IS NOT NULL`,
    [userId],
  );
  if (!row.rowCount) return null;
  return { id: Number(row.rows[0].id), entityId: row.rows[0].entity_id, jurisdiction: row.rows[0].jurisdiction };
}
