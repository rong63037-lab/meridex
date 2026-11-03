import type { PoolClient } from "pg";
import type { Db } from "./db.js";
import { withTx } from "./db.js";
import type { EngineClient } from "./engineClient.js";
import { quoteNotional, type Instrument } from "./instruments.js";
import {
  assertCaps,
  assertQty,
  assertTick,
  assertVerified,
  bookUser,
  bucketFor,
  freeMargin,
  FUNDING_BPS,
  houseExposure,
  instrumentFor,
  INTEREST_BPS,
  liqPrice,
  maintenance,
  markOf,
  nextFunding,
  payCustomer,
  payHouse,
  perpSymbols,
  pnlOf,
  productRow,
  spotOf,
  walletView,
  type BookProduct,
  LiveError,
} from "./liveCommon.js";
import { feeOf, tierBps } from "./fees.js";
import { walletAmount, type CustomerRef } from "./ledger.js";
import { LpError, applyMarkup } from "./liquidity/types.js";
import { cancelHedge, logShadow, markHedgeUnapplied, planRoute, sendHedge } from "./liquidity/route.js";
import { liveServicesEnabled } from "./runtimeFlags.js";

type OrderInput = {
  symbol: string;
  side: "buy" | "sell";
  qty: bigint;
  leverage: number;
  orderType: "market" | "limit";
  limitPx: bigint | null;
  reduceOnly: boolean;
  tp: bigint | null;
  sl: bigint | null;
  marginMode?: "cross" | "isolated";
  copyFollowId?: number | null;
  leaderPositionId?: number | null;
  copyBypass?: boolean;
};

type Pos = {
  id: string;
  user_id: number;
  product: BookProduct;
  symbol: string;
  side: string;
  qty: string;
  entry_px: string;
  leverage: number;
  margin_uusd: string;
  margin_mode: string;
  tp_px: string | null;
  sl_px: string | null;
  copy_follow_id: string | null;
  leader_position_id: string | null;
};

function num(value: string | number | null | undefined): bigint {
  return BigInt(value ?? "0");
}

async function settingsOf(pool: Db | PoolClient, userId: number, product: BookProduct) {
  const row = await pool.query(
    `SELECT mode, leverage FROM real_settings WHERE user_id = $1 AND product = $2`,
    [userId, product],
  );
  return {
    mode: (row.rows[0]?.mode as "cross" | "isolated" | undefined) ?? "isolated",
    leverage: Number(row.rows[0]?.leverage ?? 2),
  };
}

export async function setLiveSettings(
  pool: Db,
  userId: number,
  product: BookProduct,
  input: { mode?: "cross" | "isolated"; leverage?: number },
) {
  await assertVerified(pool, userId, product);
  const spec = await productRow(pool, product);
  if (!spec.enabled) throw new LiveError("LIVE_OFF");
  const leverage = input.leverage ?? 2;
  if (leverage < 1 || leverage > spec.maxLeverage) {
    throw new LiveError("CAP_LEVERAGE");
  }
  const mode = input.mode ?? "isolated";
  await pool.query(
    `INSERT INTO real_settings (user_id, product, mode, leverage) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, product) DO UPDATE SET mode = EXCLUDED.mode, leverage = EXCLUDED.leverage`,
    [userId, product, mode, leverage],
  );
  return { mode, leverage };
}

async function writeFill(
  client: PoolClient,
  row: {
    orderId?: string | null;
    positionId?: string | null;
    userId: number;
    product: string;
    symbol: string;
    side: string;
    qty: bigint;
    price: bigint;
    notional: bigint;
    realized: bigint;
    kind: string;
    feeUusd?: bigint | null;
  },
) {
  await client.query(
    `INSERT INTO real_fills (order_id, position_id, user_id, product, symbol, side, qty, price_px, notional_uusd, realized_uusd, kind, fee_uusd)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      row.orderId ?? null,
      row.positionId ?? null,
      row.userId,
      row.product,
      row.symbol,
      row.side,
      row.qty.toString(),
      row.price.toString(),
      row.notional.toString(),
      row.realized.toString(),
      row.kind,
      row.feeUusd == null ? null : row.feeUusd.toString(),
    ],
  );
}

async function takeTradeFee(
  client: PoolClient,
  user: CustomerRef,
  product: BookProduct,
  notional: bigint,
  liquidity: "maker" | "taker",
  ref: string,
): Promise<bigint> {
  if (notional <= 0n) return 0n;
  const schedule = await tierBps(client, user.id, product === "perp" ? "perp" : "spot");
  const bps = liquidity === "maker" ? schedule.maker : schedule.taker;
  const fee = feeOf(notional, bps);
  if (fee <= 0n) return 0n;
  const book = await bookUser(client);
  if (book.entityId !== user.entityId) return 0n;
  const bucket = bucketFor(product);
  const have = await walletAmount(client, user, "USD", bucket);
  if (have < fee) return 0n;
  await payHouse(client, user, book, bucket, fee, "trade_fee", ref);
  return fee;
}

async function loadOpen(client: PoolClient, userId: number, product: BookProduct, symbol: string): Promise<Pos | null> {
  const row = await client.query(
    `SELECT id::text, user_id, product, symbol, side, qty::text, entry_px::text, leverage, margin_uusd::text,
            margin_mode, tp_px::text, sl_px::text, copy_follow_id::text, leader_position_id::text
     FROM real_positions
     WHERE user_id = $1 AND product = $2 AND symbol = $3 AND status = 'open'
     FOR UPDATE`,
    [userId, product, symbol],
  );
  return (row.rows[0] as Pos | undefined) ?? null;
}

function fillPrice(side: "buy" | "sell", mark: bigint, bid: bigint, ask: bigint): bigint {
  if (side === "buy") return ask > 0n ? ask : mark;
  return bid > 0n ? bid : mark;
}

export async function placeOrder(pool: Db, engine: EngineClient, userId: number, product: BookProduct, input: OrderInput) {
  if (!input.reduceOnly && !liveServicesEnabled()) throw new LiveError("LIVE_SERVICES_DISABLED");
  const user = await assertVerified(pool, userId, product);
  const inst = instrumentFor(product, input.symbol);
  assertQty(inst, input.qty);
  const saved = await settingsOf(pool, userId, product);
  const leverage = input.leverage;
  const mode = input.marginMode ?? saved.mode;
  if (input.orderType === "limit") {
    if (input.limitPx == null) throw new LiveError("VALIDATION");
    assertTick(inst, input.limitPx);
  }
  const px = await markOf(engine, spotOf(input.symbol));
  if (px.mark <= 0n) {
    throw new LiveError("EMPTY_BOOK");
  }
  if (input.tp != null) assertTick(inst, input.tp);
  if (input.sl != null) assertTick(inst, input.sl);
  if (!input.reduceOnly) {
    if (input.tp != null && (input.side === "buy" ? input.tp <= px.mark : input.tp >= px.mark)) throw new LiveError("STOP_PRICE");
    if (input.sl != null && (input.side === "buy" ? input.sl >= px.mark : input.sl <= px.mark)) throw new LiveError("STOP_PRICE");
  }
  const marketable =
    input.orderType === "market" ||
    (input.side === "buy" && input.limitPx != null && px.mark <= input.limitPx) ||
    (input.side === "sell" && input.limitPx != null && px.mark >= input.limitPx);
  const price = input.orderType === "market" ? fillPrice(input.side, px.mark, px.bid, px.ask) : marketable ? px.mark : input.limitPx!;
  if (price <= 0n) {
    throw new LiveError("EMPTY_BOOK");
  }
  const notional = quoteNotional(input.qty, price, inst);
  const margin = notional / BigInt(leverage);
  if (!input.reduceOnly && margin <= 0n) {
    throw new LiveError("VALIDATION");
  }
  input.marginMode = mode;
  const spec = await assertCaps(pool, product, leverage, input.reduceOnly ? 0n : notional, input.reduceOnly);
  if (input.copyFollowId != null) await assertCaps(pool, "copy", leverage, notional, false);
  const plan = spec.enabled ? await planRoute(pool, { venue: product, asset: inst.base, userId }) : { kind: "internal" as const };
  let routedQty = input.qty;
  let routedPrice = price;
  if (plan.kind === "killed") throw new LiveError("LP_KILLED");
  let hedge: Awaited<ReturnType<typeof sendHedge>> | null = null;
  if (plan.kind === "live") {
    if (!marketable) throw new LiveError("LP_RESTING");
    try {
      hedge = await sendHedge(pool, plan, {
        userId,
        venue: product,
        asset: inst.base,
        symbol: input.symbol,
        side: input.side,
        qty: input.qty,
        limitPx: input.orderType === "limit" ? input.limitPx : null,
        notionalUusd: notional > 0n ? notional : 1n,
        internalPx: price,
        qtyScale: inst.qtyScale,
        priceScale: inst.priceScale,
        quoteScale: inst.quoteScale,
      });
    } catch (err) {
      if (err instanceof LpError) throw new LiveError(err.code);
      throw err;
    }
    if (hedge.filledQty <= 0n) throw new LiveError("LP_REJECTED");
    routedQty = hedge.filledQty;
    routedPrice = hedge.customerPx > 0n ? hedge.customerPx : applyMarkup(hedge.avgPx, input.side, plan.provider.spreadMarkupBps);
  }

  let result;
  try {
    result = await withTx(pool, async (client) => {
    const { free } = await freeMargin(client, user, product);
    const existing = await loadOpen(client, userId, product, input.symbol);
    if (input.reduceOnly && (!existing || existing.side === input.side)) {
      throw new LiveError("REDUCE_ONLY");
    }
    if (!marketable) {
      if (input.reduceOnly) {
        /* resting reduce-only does not lock new margin */
      } else if (free < margin) {
        throw new LiveError("INSUFFICIENT_FUNDS");
      }
      const row = await client.query(
        `INSERT INTO real_orders
          (user_id, product, symbol, side, order_type, qty, limit_px, leverage, margin_mode, reduce_only, reserved_margin_uusd, tp_px, sl_px, status, copy_follow_id)
         VALUES ($1,$2,$3,$4,'limit',$5,$6,$7,$8,$9,$10,$11,$12,'open',$13)
         RETURNING id::text`,
        [
          userId,
          product,
          input.symbol,
          input.side,
          input.qty.toString(),
          input.limitPx!.toString(),
          leverage,
          mode,
          input.reduceOnly,
          input.reduceOnly ? "0" : margin.toString(),
          input.tp?.toString() ?? null,
          input.sl?.toString() ?? null,
          input.copyFollowId ?? null,
        ],
      );
      return { status: "open" as const, id: row.rows[0].id as string, marginUusd: input.reduceOnly ? "0" : margin.toString() };
    }
    return fillNow(client, user, product, inst, { ...input, qty: routedQty }, routedPrice, existing, free, null);
  });
  } catch (err) {
    if (hedge && hedge.filledQty > 0n) {
      await markHedgeUnapplied(pool, hedge.clientOrderId);
      await cancelHedge(pool, hedge.providerId, hedge.clientOrderId);
    }
    throw err;
  }
  if (plan.kind === "shadow" && result.status === "filled") {
    await logShadow(pool, plan.provider, {
      userId,
      venue: product,
      asset: inst.base,
      symbol: input.symbol,
      side: input.side,
      qty: input.qty,
      internalPx: routedPrice,
      filledQty: input.qty,
      status: "filled",
    });
  }
  if (result.status === "filled" && !input.copyFollowId) {
    if ((result.closedFraction ?? 0) > 0 && result.closedLeaderId) {
      await replicateClose(pool, engine, result.closedLeaderId, result.closedFraction ?? 0);
    } else if (result.positionId) {
      await replicateLeader(pool, engine, userId, result.positionId, 0);
    }
  }
  return result;
}

async function fillNow(
  client: PoolClient,
  user: CustomerRef,
  product: BookProduct,
  inst: Instrument,
  input: OrderInput,
  price: bigint,
  existing: Pos | null,
  free: bigint,
  reuseOrderId: string | null,
  liquidity: "maker" | "taker" = "taker",
) {
  let qty = input.qty;
  const reducing = existing != null && existing.side !== input.side;
  if (input.reduceOnly) {
    if (!reducing || !existing) throw new LiveError("REDUCE_ONLY");
    if (qty > num(existing.qty)) qty = num(existing.qty);
  }
  let orderId: string;
  if (reuseOrderId) {
    await client.query(
      `UPDATE real_orders
       SET status = 'filled', filled_qty = $2, avg_px = $3, reserved_margin_uusd = 0, updated_at = now()
       WHERE id = $1`,
      [reuseOrderId, qty.toString(), price.toString()],
    );
    orderId = reuseOrderId;
  } else {
    const order = await client.query(
      `INSERT INTO real_orders
        (user_id, product, symbol, side, order_type, qty, limit_px, leverage, margin_mode, reduce_only, reserved_margin_uusd, tp_px, sl_px, status, filled_qty, avg_px, copy_follow_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12,'filled',$6,$13,$14)
       RETURNING id::text`,
      [
        user.id,
        product,
        input.symbol,
        input.side,
        input.orderType,
        qty.toString(),
        input.limitPx?.toString() ?? null,
        input.leverage,
        input.marginMode ?? "isolated",
        input.reduceOnly,
        input.tp?.toString() ?? null,
        input.sl?.toString() ?? null,
        price.toString(),
        input.copyFollowId ?? null,
      ],
    );
    orderId = order.rows[0].id as string;
  }
  if (!reducing) {
    const notional = quoteNotional(qty, price, inst);
    const margin = notional / BigInt(input.leverage);
    const schedule = await tierBps(client, user.id, product === "perp" ? "perp" : "spot");
    const openFee = feeOf(notional, liquidity === "maker" ? schedule.maker : schedule.taker);
    if (margin <= 0n || free < margin + openFee) throw new LiveError("INSUFFICIENT_FUNDS");
    const positionId = await addPosition(client, user.id, product, input, qty, price, margin, existing);
    const charged = await takeTradeFee(client, user, product, notional, liquidity, orderId);
    await writeFill(client, {
      orderId,
      positionId,
      userId: user.id,
      product,
      symbol: input.symbol,
      side: input.side,
      qty,
      price,
      notional,
      realized: 0n,
      kind: "open",
      feeUusd: charged,
    });
    return { status: "filled" as const, id: orderId, positionId, marginUusd: margin.toString(), entry: price.toString(), closedFraction: 0, closedLeaderId: null as string | null };
  }
  const position = existing!;
  const have = num(position.qty);
  const closeQty = qty < have ? qty : have;
  const fraction = Number((closeQty * 10000n) / have);
  const closed = await realize(client, user, product, inst, position, closeQty, price, "close", orderId, liquidity);
  let opened: string | null = closed.positionId;
  if (qty > have && !input.reduceOnly) {
    const rest = qty - have;
    const notional = quoteNotional(rest, price, inst);
    const margin = notional / BigInt(input.leverage);
    const schedule = await tierBps(client, user.id, product === "perp" ? "perp" : "spot");
    const openFee = feeOf(notional, liquidity === "maker" ? schedule.maker : schedule.taker);
    const { free: left } = await freeMargin(client, user, product);
    if (margin <= 0n || left < margin + openFee) throw new LiveError("INSUFFICIENT_FUNDS");
    const flip: OrderInput = { ...input, side: input.side, qty: rest, reduceOnly: false };
    opened = await addPosition(client, user.id, product, flip, rest, price, margin, null);
    const charged = await takeTradeFee(client, user, product, notional, liquidity, orderId);
    await writeFill(client, {
      orderId,
      positionId: opened,
      userId: user.id,
      product,
      symbol: input.symbol,
      side: input.side,
      qty: rest,
      price,
      notional,
      realized: 0n,
      kind: "open",
      feeUusd: charged,
    });
  }
  return {
    status: "filled" as const,
    id: orderId,
    positionId: opened,
    marginUusd: closed.released.toString(),
    entry: price.toString(),
    pnlUusd: closed.pnl.toString(),
    closedFraction: fraction,
    closedLeaderId: position.leader_position_id ? null : position.id,
  };
}

async function addPosition(
  client: PoolClient,
  userId: number,
  product: BookProduct,
  input: OrderInput,
  qty: bigint,
  price: bigint,
  margin: bigint,
  existing: Pos | null,
): Promise<string> {
  if (existing && existing.side === input.side) {
    const oldQty = num(existing.qty);
    const oldEntry = num(existing.entry_px);
    const newQty = oldQty + qty;
    const entry = (oldEntry * oldQty + price * qty) / newQty;
    const nextMargin = num(existing.margin_uusd) + margin;
    await client.query(
      `UPDATE real_positions
       SET qty = $2, entry_px = $3, margin_uusd = $4, leverage = $5, tp_px = COALESCE($6, tp_px), sl_px = COALESCE($7, sl_px), updated_at = now()
       WHERE id = $1`,
      [existing.id, newQty.toString(), entry.toString(), nextMargin.toString(), input.leverage, input.tp?.toString() ?? null, input.sl?.toString() ?? null],
    );
    return existing.id;
  }
  const row = await client.query(
    `INSERT INTO real_positions
      (user_id, product, symbol, side, qty, entry_px, leverage, margin_uusd, margin_mode, tp_px, sl_px, status, next_funding_at, copy_follow_id, leader_position_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'open',$12,$13,$14)
     RETURNING id::text`,
    [
      userId,
      product,
      input.symbol,
      input.side,
      qty.toString(),
      price.toString(),
      input.leverage,
      margin.toString(),
      input.marginMode ?? "isolated",
      input.tp?.toString() ?? null,
      input.sl?.toString() ?? null,
      nextFunding().toISOString(),
      input.copyFollowId ?? null,
      input.leaderPositionId ?? null,
    ],
  );
  return row.rows[0].id as string;
}

async function realize(
  client: PoolClient,
  user: CustomerRef,
  product: BookProduct,
  inst: Instrument,
  position: Pos,
  closeQty: bigint,
  price: bigint,
  kind: "close" | "liquidation",
  orderId: string | null,
  liquidity: "maker" | "taker" = "taker",
) {
  const have = num(position.qty);
  if (closeQty <= 0n || closeQty > have) throw new LiveError("VALIDATION");
  const entry = num(position.entry_px);
  const pnl = pnlOf(inst, position.side, closeQty, entry, price);
  const margin = num(position.margin_uusd);
  const released = (margin * closeQty) / have;
  const book = await bookUser(client);
  const bucket = bucketFor(product);
  if (pnl < 0n) {
    const loss = -pnl > released ? released : -pnl;
    if (loss > 0n) await payHouse(client, user, book, bucket, loss, kind === "liquidation" ? "live_liquidation" : "live_loss", position.id);
  } else if (pnl > 0n) {
    await payCustomer(client, book, user, bucket, pnl, product, `close:${position.id}`);
  }
  const notional = quoteNotional(closeQty, price, inst);
  const remainingQty = have - closeQty;
  const remainingMargin = margin - released;
  let positionId = position.id;
  if (remainingQty === 0n) {
    await client.query(
      `UPDATE real_positions
       SET status = $2, realized_uusd = realized_uusd + $3, margin_uusd = 0, updated_at = now()
       WHERE id = $1`,
      [position.id, kind === "liquidation" ? "liquidated" : "closed", pnl.toString()],
    );
  } else {
    await client.query(
      `UPDATE real_positions
       SET qty = $2, margin_uusd = $3, realized_uusd = realized_uusd + $4, updated_at = now()
       WHERE id = $1`,
      [position.id, remainingQty.toString(), remainingMargin.toString(), pnl.toString()],
    );
  }
  const charged = await takeTradeFee(client, user, product, notional, liquidity, orderId ?? position.id);
  await writeFill(client, {
    orderId,
    positionId,
    userId: user.id,
    product,
    symbol: position.symbol,
    side: position.side === "buy" ? "sell" : "buy",
    qty: closeQty,
    price,
    notional,
    realized: pnl,
    kind,
    feeUusd: charged,
  });
  return { pnl, released, positionId: remainingQty === 0n ? null : position.id };
}

export async function cancelOrder(pool: Db, userId: number, product: BookProduct, orderId: string) {
  await assertVerified(pool, userId, product);
  const row = await pool.query(
    `UPDATE real_orders SET status = 'canceled', reserved_margin_uusd = 0, updated_at = now()
     WHERE id = $1 AND user_id = $2 AND product = $3 AND status = 'open'
     RETURNING id::text`,
    [orderId, userId, product],
  );
  if (!row.rowCount) {
    throw new LiveError("NOT_FOUND");
  }
  return { id: orderId, status: "canceled" };
}

export async function closePosition(
  pool: Db,
  engine: EngineClient,
  userId: number,
  product: BookProduct,
  positionId: string,
  qty: bigint | null,
) {
  const user = await assertVerified(pool, userId, product);
  const instRow = await pool.query(
    `SELECT symbol FROM real_positions WHERE id = $1 AND user_id = $2 AND product = $3 AND status = 'open'`,
    [positionId, userId, product],
  );
  if (!instRow.rowCount) {
    throw new LiveError("NOT_FOUND");
  }
  const symbol = instRow.rows[0].symbol as string;
  const inst = instrumentFor(product, symbol);
  const px = await markOf(engine, spotOf(symbol));
  if (px.mark <= 0n) {
    throw new LiveError("EMPTY_BOOK");
  }
  const side = await pool.query(`SELECT side FROM real_positions WHERE id = $1`, [positionId]);
  const closeSide = side.rows[0].side === "buy" ? "sell" : "buy";
  const price = fillPrice(closeSide, px.mark, px.bid, px.ask);
  const result = await withTx(pool, async (client) => {
    const position = await client.query(
      `SELECT id::text, user_id, product, symbol, side, qty::text, entry_px::text, leverage, margin_uusd::text,
              margin_mode, tp_px::text, sl_px::text, copy_follow_id::text, leader_position_id::text
       FROM real_positions WHERE id = $1 AND user_id = $2 AND status = 'open' FOR UPDATE`,
      [positionId, userId],
    );
    if (!position.rowCount) {
      throw new LiveError("NOT_FOUND");
    }
    const pos = position.rows[0] as Pos;
    const have = num(pos.qty);
    let closeQty = qty == null || qty >= have ? have : qty;
    if (closeQty !== have && (closeQty < BigInt(inst.minQty) || have - closeQty < BigInt(inst.minQty))) {
      if (qty != null && closeQty < BigInt(inst.minQty)) throw new LiveError("MIN_QTY");
      closeQty = have;
    }
    if (closeQty !== have) assertQty(inst, closeQty);
    const closed = await realize(client, user, product, inst, pos, closeQty, price, "close", null);
    return { id: positionId, status: closeQty === have ? "closed" : "open", pnlUusd: closed.pnl.toString(), leaderId: pos.leader_position_id ? null : pos.id, fraction: Number((closeQty * 10000n) / have) };
  });
  if (result.leaderId) await replicateClose(pool, engine, result.leaderId, result.fraction);
  return result;
}

export async function closeAll(pool: Db, engine: EngineClient, userId: number, product: BookProduct) {
  const rows = await pool.query(
    `SELECT id::text FROM real_positions WHERE user_id = $1 AND product = $2 AND status = 'open' ORDER BY id`,
    [userId, product],
  );
  const closed = [];
  for (const row of rows.rows) {
    closed.push(await closePosition(pool, engine, userId, product, row.id as string, null));
  }
  await pool.query(
    `UPDATE real_orders SET status = 'canceled', reserved_margin_uusd = 0, updated_at = now()
     WHERE user_id = $1 AND product = $2 AND status = 'open'`,
    [userId, product],
  );
  return { closed };
}

export async function adjustMargin(
  pool: Db,
  userId: number,
  product: BookProduct,
  positionId: string,
  action: "add" | "remove",
  amount: bigint,
) {
  if (amount <= 0n) {
    throw new LiveError("VALIDATION");
  }
  const user = await assertVerified(pool, userId, product);
  const spec = await productRow(pool, product);
  if (action === "add" && !spec.enabled) {
    throw new LiveError("LIVE_OFF");
  }
  return withTx(pool, async (client) => {
    const row = await client.query(
      `SELECT id::text, symbol, qty::text, entry_px::text, leverage, margin_uusd::text, margin_mode
       FROM real_positions WHERE id = $1 AND user_id = $2 AND product = $3 AND status = 'open' FOR UPDATE`,
      [positionId, userId, product],
    );
    if (!row.rowCount) {
      throw new LiveError("NOT_FOUND");
    }
    const pos = row.rows[0];
    const inst = instrumentFor(product, pos.symbol as string);
    const margin = num(pos.margin_uusd as string);
    if (action === "add") {
      const { free } = await freeMargin(client, user, product);
      if (free < amount) {
        throw new LiveError("INSUFFICIENT_FUNDS");
      }
      await client.query(`UPDATE real_positions SET margin_uusd = margin_uusd + $2, updated_at = now() WHERE id = $1`, [
        positionId,
        amount.toString(),
      ]);
      return { marginUusd: (margin + amount).toString() };
    }
    const notional = quoteNotional(num(pos.qty as string), num(pos.entry_px as string), inst);
    const floor = maintenance(notional, Number(pos.leverage));
    if (margin - amount <= floor) {
      throw new LiveError("BELOW_MAINTENANCE");
    }
    await client.query(`UPDATE real_positions SET margin_uusd = margin_uusd - $2, updated_at = now() WHERE id = $1`, [
      positionId,
      amount.toString(),
    ]);
    return { marginUusd: (margin - amount).toString() };
  });
}

async function extraFree(client: PoolClient, user: CustomerRef, product: BookProduct, mode: string): Promise<bigint> {
  if (mode !== "cross") return 0n;
  const { free } = await freeMargin(client, user, product);
  return free;
}

export async function settleDue(pool: Db, engine: EngineClient) {
  await matchLimits(pool, engine);
  await settleFunding(pool, engine);
  await liquidate(pool, engine);
  await enforceCopyStops(pool, engine);
}

async function matchLimits(pool: Db, engine: EngineClient) {
  const orders = await pool.query(
    `SELECT id::text, user_id, product, symbol, side, qty::text, limit_px::text, leverage, margin_mode, reduce_only, tp_px::text, sl_px::text, copy_follow_id::text
     FROM real_orders WHERE status = 'open' AND order_type = 'limit' ORDER BY id LIMIT 40`,
  );
  for (const row of orders.rows) {
    const product = row.product as BookProduct;
    let px;
    try {
      px = await markOf(engine, spotOf(row.symbol as string));
    } catch {
      continue;
    }
    const limit = num(row.limit_px as string);
    const side = row.side as "buy" | "sell";
    const crossed = side === "buy" ? px.mark <= limit : px.mark >= limit;
    if (!crossed || px.mark <= 0n) continue;
    const spec = await productRow(pool, product);
    if (!spec.enabled && !row.reduce_only) continue;
    try {
      const user = await assertVerified(pool, Number(row.user_id), product);
      const inst = instrumentFor(product, row.symbol as string);
      const filled = await withTx(pool, async (client) => {
        const still = await client.query(`SELECT status, reserved_margin_uusd::text FROM real_orders WHERE id = $1 FOR UPDATE`, [row.id]);
        if (still.rows[0]?.status !== "open") return null;
        await client.query(`UPDATE real_orders SET reserved_margin_uusd = 0 WHERE id = $1`, [row.id]);
        const existing = await loadOpen(client, user.id, product, row.symbol as string);
        const input: OrderInput = {
          symbol: row.symbol as string,
          side,
          qty: num(row.qty as string),
          leverage: Number(row.leverage),
          orderType: "limit",
          limitPx: limit,
          reduceOnly: Boolean(row.reduce_only),
          tp: row.tp_px ? num(row.tp_px as string) : null,
          sl: row.sl_px ? num(row.sl_px as string) : null,
          marginMode: row.margin_mode as "cross" | "isolated",
          copyFollowId: row.copy_follow_id ? Number(row.copy_follow_id) : null,
        };
        const { free } = await freeMargin(client, user, product);
        return fillNow(client, user, product, inst, input, px.mark, existing, free, String(row.id), "maker");
      });
      if (filled && !row.copy_follow_id) await replicateLeader(pool, engine, Number(row.user_id), filled.positionId, filled.closedFraction ?? 0);
    } catch (err) {
      console.error("live limit", row.id, err instanceof Error ? err.message : err);
    }
  }
}

async function settleFunding(pool: Db, engine: EngineClient) {
  const due = await pool.query(
    `SELECT id::text, user_id, product, symbol, side, qty::text, entry_px::text, leverage, margin_uusd::text, margin_mode
     FROM real_positions WHERE status = 'open' AND next_funding_at <= now() ORDER BY id LIMIT 80`,
  );
  for (const row of due.rows) {
    try {
      const product = row.product as BookProduct;
      const inst = instrumentFor(product, row.symbol as string);
      const px = await markOf(engine, spotOf(row.symbol as string));
      if (px.mark <= 0n) continue;
      const qty = num(row.qty as string);
      const notional = quoteNotional(qty, px.mark, inst);
      const user = await assertVerified(pool, Number(row.user_id), product);
      const book = await bookUser(pool);
      await withTx(pool, async (client) => {
        const locked = await client.query(
          `SELECT margin_uusd::text, status FROM real_positions WHERE id = $1 FOR UPDATE`,
          [row.id],
        );
        if (locked.rows[0]?.status !== "open") return;
        const margin = num(locked.rows[0].margin_uusd as string);
        const bps = product === "margin" ? INTEREST_BPS : FUNDING_BPS;
        let payment = (notional * BigInt(bps)) / 10_000n;
        if (product === "margin") {
          const borrowed = notional > margin ? notional - margin : 0n;
          payment = (borrowed * BigInt(INTEREST_BPS)) / 10_000n;
        }
        const bucket = bucketFor(product);
        if (payment > 0n && (product === "margin" || row.side === "buy")) {
          const take = payment > margin ? margin : payment;
          if (take > 0n) {
            await payHouse(client, user, book, bucket, take, product === "margin" ? "live_interest" : "live_funding", String(row.id));
            await client.query(`UPDATE real_positions SET margin_uusd = margin_uusd - $2 WHERE id = $1`, [row.id, take.toString()]);
          }
          await writeFill(client, {
            positionId: String(row.id),
            userId: user.id,
            product,
            symbol: row.symbol as string,
            side: row.side as string,
            qty: 0n,
            price: px.mark,
            notional,
            realized: take > 0n ? -take : 0n,
            kind: product === "margin" ? "interest" : "funding",
          });
        } else if (payment > 0n && product === "perp" && row.side === "sell") {
          const paid = await payCustomer(client, book, user, bucket, payment, product, `funding:${row.id}`);
          if (paid.paid > 0n) {
            await client.query(`UPDATE real_positions SET margin_uusd = margin_uusd + $2 WHERE id = $1`, [row.id, paid.paid.toString()]);
          }
          await writeFill(client, {
            positionId: String(row.id),
            userId: user.id,
            product,
            symbol: row.symbol as string,
            side: "sell",
            qty: 0n,
            price: px.mark,
            notional,
            realized: paid.paid,
            kind: "funding",
          });
        }
        await client.query(`UPDATE real_positions SET next_funding_at = $2, updated_at = now() WHERE id = $1 AND status = 'open'`, [
          row.id,
          nextFunding().toISOString(),
        ]);
      });
    } catch (err) {
      console.error("live funding", row.id, err instanceof Error ? err.message : err);
    }
  }
}

async function liquidate(pool: Db, engine: EngineClient) {
  const open = await pool.query(
    `SELECT id::text, user_id, product, symbol, side, qty::text, entry_px::text, leverage, margin_uusd::text, margin_mode, tp_px::text, sl_px::text
     FROM real_positions WHERE status = 'open' ORDER BY id LIMIT 80`,
  );
  for (const row of open.rows) {
    try {
      const product = row.product as BookProduct;
      const inst = instrumentFor(product, row.symbol as string);
      const px = await markOf(engine, spotOf(row.symbol as string));
      if (px.mark <= 0n) continue;
      const user = await assertVerified(pool, Number(row.user_id), product);
      await withTx(pool, async (client) => {
        const locked = await client.query(
          `SELECT id::text, user_id, product, symbol, side, qty::text, entry_px::text, leverage, margin_uusd::text, margin_mode,
                  tp_px::text, sl_px::text, copy_follow_id::text, leader_position_id::text, status
           FROM real_positions WHERE id = $1 FOR UPDATE`,
          [row.id],
        );
        if (locked.rows[0]?.status !== "open") return;
        const pos = locked.rows[0] as Pos;
        const qty = num(pos.qty);
        const entry = num(pos.entry_px);
        const margin = num(pos.margin_uusd);
        const pnl = pnlOf(inst, pos.side, qty, entry, px.mark);
        const notional = quoteNotional(qty, px.mark, inst);
        const extra = await extraFree(client, user, product, pos.margin_mode);
        const floor = maintenance(notional, Number(pos.leverage));
        const equity = margin + extra + pnl;
        const tp = pos.tp_px ? num(pos.tp_px) : null;
        const sl = pos.sl_px ? num(pos.sl_px) : null;
        const hitTp = tp != null && (pos.side === "buy" ? px.mark >= tp : px.mark <= tp);
        const hitSl = sl != null && (pos.side === "buy" ? px.mark <= sl : px.mark >= sl);
        if (equity > floor && !hitTp && !hitSl) return;
        const kind = equity <= floor ? "liquidation" : "close";
        const price = fillPrice(pos.side === "buy" ? "sell" : "buy", px.mark, px.bid, px.ask);
        await realize(client, user, product, inst, pos, qty, price, kind, null);
      });
    } catch (err) {
      console.error("live liq", row.id, err instanceof Error ? err.message : err);
    }
  }
}

async function enforceCopyStops(pool: Db, engine: EngineClient) {
  const follows = await pool.query(
    `SELECT id::text, follower_id, max_loss_uusd::text FROM real_copy_follows WHERE status = 'active'`,
  );
  for (const follow of follows.rows) {
    const positions = await pool.query(
      `SELECT id::text, symbol, product, side, qty::text, entry_px::text, realized_uusd::text, status
       FROM real_positions WHERE copy_follow_id = $1`,
      [follow.id],
    );
    let pnl = 0n;
    for (const pos of positions.rows) {
      pnl += num(pos.realized_uusd as string);
      if (pos.status !== "open") continue;
      try {
        const inst = instrumentFor(pos.product as BookProduct, pos.symbol as string);
        const px = await markOf(engine, spotOf(pos.symbol as string));
        pnl += pnlOf(inst, pos.side as string, num(pos.qty as string), num(pos.entry_px as string), px.mark);
      } catch {
        /* keep realised only */
      }
    }
    if (pnl > -num(follow.max_loss_uusd as string)) continue;
    await pool.query(`UPDATE real_copy_follows SET status = 'paused' WHERE id = $1 AND status = 'active'`, [follow.id]);
    const open = positions.rows.filter((row) => row.status === "open");
    for (const pos of open) {
      try {
        await closePosition(pool, engine, Number(follow.follower_id), pos.product as BookProduct, pos.id as string, null);
      } catch (err) {
        console.error("copy stop", pos.id, err instanceof Error ? err.message : err);
      }
    }
  }
}

async function replicateLeader(pool: Db, engine: EngineClient, leaderId: number, positionId: string | null, closedFraction: number) {
  if (!positionId) return;
  if (closedFraction > 0) {
    await replicateClose(pool, engine, positionId, closedFraction);
    return;
  }
  const follows = await pool.query(
    `SELECT id::text, follower_id, allocation_uusd::text, ratio_bps, max_loss_uusd::text
     FROM real_copy_follows WHERE leader_id = $1 AND status = 'active'`,
    [leaderId],
  );
  if (!follows.rowCount) return;
  const copyOn = await productRow(pool, "copy");
  if (!copyOn.enabled) return;
  const leaderPos = await pool.query(
    `SELECT id::text, product, symbol, side, qty::text, entry_px::text, leverage, margin_mode, user_id
     FROM real_positions WHERE id = $1 AND status = 'open' AND copy_follow_id IS NULL`,
    [positionId],
  );
  if (!leaderPos.rowCount) return;
  const leader = leaderPos.rows[0];
  const equityRow = await pool.query(
    `SELECT COALESCE(SUM(b.amount),0)::text AS n
     FROM accounts a JOIN balances b ON b.account_id = a.id
     WHERE a.customer_id = $1 AND a.asset = 'USD' AND a.bucket = $2`,
    [leader.user_id, bucketFor(leader.product as BookProduct)],
  );
  const equity = num(equityRow.rows[0].n as string);
  if (equity <= 0n) return;
  for (const follow of follows.rows) {
    try {
      const product = leader.product as BookProduct;
      const inst = instrumentFor(product, leader.symbol as string);
      const leaderQty = num(leader.qty as string);
      const allocation = num(follow.allocation_uusd as string);
      const ratio = BigInt(follow.ratio_bps as number);
      const step = BigInt(inst.minQty);
      let target = (leaderQty * allocation * ratio) / (equity * 10_000n);
      if (target < step) continue;
      target = target - (target % step);
      const price = num(leader.entry_px as string);
      const leverage = Math.max(2, Math.min(Number(leader.leverage), (await productRow(pool, product)).maxLeverage));
      let notional = quoteNotional(target, price, inst);
      let margin = notional / BigInt(leverage);
      if (margin > allocation && margin > 0n) {
        target = (target * allocation) / margin;
        target = target - (target % step);
        if (target < step) continue;
        notional = quoteNotional(target, price, inst);
        margin = notional / BigInt(leverage);
      }
      const haveRow = await pool.query(
        `SELECT COALESCE(SUM(qty),0)::text AS n FROM real_positions
         WHERE leader_position_id = $1 AND copy_follow_id = $2 AND status = 'open' AND side = $3`,
        [positionId, follow.id, leader.side],
      );
      const have = num(haveRow.rows[0].n as string);
      if (target <= have) continue;
      const qty = target - have;
      if (qty < step) continue;
      await placeOrder(pool, engine, Number(follow.follower_id), product, {
        symbol: leader.symbol as string,
        side: leader.side as "buy" | "sell",
        qty,
        leverage,
        orderType: "market",
        limitPx: null,
        reduceOnly: false,
        tp: null,
        sl: null,
        marginMode: "isolated",
        copyFollowId: Number(follow.id),
        leaderPositionId: Number(positionId),
      });
    } catch (err) {
      console.error("copy open", follow.id, err instanceof Error ? err.message : err);
    }
  }
}

async function replicateClose(pool: Db, engine: EngineClient, leaderPositionId: string, fraction: number) {
  const kids = await pool.query(
    `SELECT id::text, user_id, product, qty::text FROM real_positions
     WHERE leader_position_id = $1 AND status = 'open'`,
    [leaderPositionId],
  );
  const bps = BigInt(Math.min(10_000, Math.max(0, fraction)));
  for (const kid of kids.rows) {
    try {
      const qty = (num(kid.qty as string) * bps) / 10_000n;
      await closePosition(pool, engine, Number(kid.user_id), kid.product as BookProduct, kid.id as string, bps >= 10_000n ? null : qty);
    } catch (err) {
      console.error("copy close", kid.id, err instanceof Error ? err.message : err);
    }
  }
}

export async function closeCopied(pool: Db, engine: EngineClient, followerId: number, followId: string) {
  const rows = await pool.query(
    `SELECT id::text, product FROM real_positions WHERE user_id = $1 AND copy_follow_id = $2 AND status = 'open'`,
    [followerId, followId],
  );
  for (const row of rows.rows) {
    await closePosition(pool, engine, followerId, row.product as BookProduct, row.id as string, null);
  }
}

export async function liveBoard(pool: Db, engine: EngineClient, userId: number, product: BookProduct) {
  const spec = await productRow(pool, product);
  const saved = await settingsOf(pool, userId, product);
  let access = "allow";
  try {
    await assertVerified(pool, userId, product);
  } catch (err) {
    access = err instanceof Error ? err.message : "FORBIDDEN";
  }
  const wallets = await walletView(pool, userId);
  const walletUsd = product === "margin" ? BigInt(wallets.marginUusd) : BigInt(wallets.derivativesUusd);
  const positions = await pool.query(
    `SELECT id::text, symbol, side, qty::text, entry_px::text, leverage, margin_uusd::text, margin_mode,
            tp_px::text, sl_px::text, status, realized_uusd::text, copy_follow_id::text, created_at
     FROM real_positions WHERE user_id = $1 AND product = $2 ORDER BY id DESC LIMIT 40`,
    [userId, product],
  );
  const openPositions = positions.rows.filter((row) => row.status === "open");
  const orders = await pool.query(
    `SELECT id::text, symbol, side, order_type, qty::text, limit_px::text, leverage, reduce_only, status, filled_qty::text, avg_px::text, reserved_margin_uusd::text, created_at
     FROM real_orders WHERE user_id = $1 AND product = $2 ORDER BY id DESC LIMIT 40`,
    [userId, product],
  );
  const fills = await pool.query(
    `SELECT id::text, symbol, side, qty::text, price_px::text, notional_uusd::text, realized_uusd::text, fee_uusd::text, kind, created_at
     FROM real_fills WHERE user_id = $1 AND product = $2 ORDER BY id DESC LIMIT 40`,
    [userId, product],
  );
  const symbols = product === "perp" ? perpSymbols() : ["XAU/USD", "XAG/USD", "BTC/USD", "ETH/USD"];
  const markets = [];
  for (const symbol of symbols) {
    const spot = spotOf(symbol);
    let mark = 0n;
    let index = 0n;
    try {
      const px = await markOf(engine, spot);
      mark = px.mark;
      index = px.index;
    } catch {
      mark = 0n;
    }
    markets.push({
      symbol,
      spot,
      mark: mark.toString(),
      index: index.toString(),
      fundingBps: product === "perp" ? FUNDING_BPS : INTEREST_BPS,
      fundingAt: nextFunding().toISOString(),
    });
  }
  const posLocked = openPositions.reduce((sum, row) => sum + num(row.margin_uusd as string), 0n);
  const reserved = orders.rows
    .filter((row) => row.status === "open")
    .reduce((sum, row) => sum + num(String(row.reserved_margin_uusd ?? "0")), 0n);
  const locked = posLocked + reserved;
  const freeWallet = walletUsd > locked ? walletUsd - locked : 0n;
  const shaped = [];
  for (const row of openPositions) {
    const inst = instrumentFor(product, row.symbol as string);
    const market = markets.find((item) => item.symbol === row.symbol);
    const mark = BigInt(market?.mark ?? "0");
    const qty = num(row.qty as string);
    const entry = num(row.entry_px as string);
    const margin = num(row.margin_uusd as string);
    const upnl = mark > 0n ? pnlOf(inst, row.side as string, qty, entry, mark) : 0n;
    const notional = mark > 0n ? quoteNotional(qty, mark, inst) : quoteNotional(qty, entry, inst);
    const extra = row.margin_mode === "cross" ? freeWallet : 0n;
    const floor = maintenance(notional, Number(row.leverage));
    const cushion = margin + extra - floor;
    shaped.push({
      ...row,
      mark: mark.toString(),
      upnlUusd: upnl.toString(),
      liq: liqPrice(inst, row.side as string, qty, entry, cushion),
      notionalUusd: notional.toString(),
    });
  }
  const reduceOnly = !spec.enabled && (openPositions.length > 0 || walletUsd > 0n || orders.rows.some((row) => row.status === "open"));
  return {
    paper: false,
    live: spec.enabled && access === "allow",
    reduceOnly,
    access,
    mode: saved.mode,
    leverage: Math.min(saved.leverage, spec.maxLeverage),
    maxLeverage: spec.maxLeverage,
    maxNotionalUusd: spec.maxNotional.toString(),
    freeUusd: freeWallet.toString(),
    lockedUusd: locked.toString(),
    fundingBps: FUNDING_BPS,
    interestBps: INTEREST_BPS,
    wallets,
    markets,
    positions: shaped,
    historyPositions: positions.rows.filter((row) => row.status !== "open"),
    orders: orders.rows.filter((row) => row.status === "open"),
    history: orders.rows.filter((row) => row.status !== "open"),
    fills: fills.rows,
  };
}

export { houseExposure };
