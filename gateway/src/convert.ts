import type { Db } from "./db.js";
import { withTx } from "./db.js";
import type { EngineClient } from "./engineClient.js";
import { offeredTo } from "./coverage.js";
import { categoryAccess, getInstrument, quoteNotional, type Instrument } from "./instruments.js";
import { LedgerError, moveAvailable, type CustomerRef } from "./ledger.js";
import { ModeError, assertMode } from "./modes.js";
import { PaperReject, chargePaperUsd, paperEnabled, paperUsdAvailable, placePaperOrder } from "./paper.js";
import { loadBot } from "./seed.js";
import { cancelOrder, loadCustomer, placeOrder } from "./trading.js";
import { convertBps } from "./content.js";

export const SPREAD_BPS = 8;
export const FEE_BPS = 10;
export const QUOTE_MS = 10_000;

type Level = { price: number; qty: number };

export class ConvertError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

function roundTick(px: bigint, tick: bigint, up: boolean): bigint {
  if (tick <= 1n) return px;
  const mod = px % tick;
  if (mod === 0n) return px;
  return up ? px + (tick - mod) : px - mod;
}

function vwap(levels: Level[], qty: bigint): bigint | null {
  let left = qty;
  let notion = 0n;
  let filled = 0n;
  for (const lvl of levels) {
    if (lvl.price <= 0 || lvl.qty <= 0) continue;
    const have = BigInt(Math.round(lvl.qty));
    const take = have < left ? have : left;
    notion += take * BigInt(Math.round(lvl.price));
    filled += take;
    left -= take;
    if (left === 0n) break;
  }
  if (filled === 0n) return null;
  return notion / filled;
}

function firmPrice(touch: bigint, side: "buy" | "sell", tick: bigint, spreadBps: number): bigint {
  const num = side === "buy" ? 10_000 + spreadBps : 10_000 - spreadBps;
  const raw = (touch * BigInt(num)) / 10_000n;
  return roundTick(raw <= 0n ? 1n : raw, tick, side === "buy");
}

function worse(side: "buy" | "sell", next: bigint, touch: bigint, slippageBps: number): boolean {
  const limit = side === "buy"
    ? (touch * BigInt(10_000 + slippageBps)) / 10_000n
    : (touch * BigInt(10_000 - slippageBps)) / 10_000n;
  return side === "buy" ? next > limit : next < limit;
}

async function tradable(pool: Db, userId: number, inst: Instrument): Promise<CustomerRef> {
  const customer = await loadCustomer(pool, userId);
  if (!customer) throw new ConvertError("KYC_REQUIRED");
  if (inst.status !== "trading") throw new ConvertError("MARKET_HALTED");
  if (!offeredTo(customer.jurisdiction)) throw new ConvertError("JURISDICTION_CLOSED");
  const access = await categoryAccess(pool, inst.category, customer.jurisdiction);
  if (access === "block") throw new ConvertError("CATEGORY_BLOCKED");
  if (access !== "allow") throw new ConvertError("CATEGORY_PENDING");
  return customer;
}

export async function quoteConvert(
  pool: Db,
  engine: EngineClient,
  userId: number,
  input: { symbol: string; side: "buy" | "sell"; qty: bigint; slippageBps: number; paper: boolean },
) {
  await assertMode(pool, userId, "convert", input.paper);
  if (input.paper && !(await paperEnabled(pool, userId))) throw new ConvertError("PAPER_OFF");
  let inst: Instrument;
  try {
    inst = getInstrument(input.symbol);
  } catch {
    throw new ConvertError("UNKNOWN_SYMBOL");
  }
  if (input.qty < BigInt(inst.minQty)) throw new ConvertError("VALIDATION");
  if (input.slippageBps < 0 || input.slippageBps > 200) throw new ConvertError("VALIDATION");
  const customer = await tradable(pool, userId, inst);
  const book = await engine.book(inst.symbol);
  if (book.halted) throw new ConvertError("MARKET_HALTED");
  const levels = input.side === "buy" ? book.asks : book.bids;
  const touchAvg = vwap(levels, input.qty) ?? (levels[0] ? BigInt(Math.round(levels[0].price)) : null);
  if (touchAvg == null || touchAvg <= 0n) throw new ConvertError("EMPTY_BOOK");
  const bps = await convertBps(pool);
  const price = firmPrice(touchAvg, input.side, BigInt(inst.tickSize), bps.spread);
  const notional = quoteNotional(input.qty, price, inst);
  const fee = (notional * BigInt(bps.fee)) / 10_000n;
  if (input.paper) {
    if (input.side === "buy") {
      const have = await paperUsdAvailable(pool, userId);
      if (have < notional + fee) throw new ConvertError("INSUFFICIENT_FUNDS");
    }
  } else if (input.side === "buy") {
    const row = await pool.query(
      `SELECT b.amount::text AS n FROM accounts a JOIN balances b ON b.account_id = a.id
       WHERE a.customer_id = $1 AND a.asset = $2 AND a.bucket = 'available' AND a.entity_id = $3`,
      [customer.id, inst.quote, customer.entityId],
    );
    if (BigInt((row.rows[0]?.n as string | undefined) ?? "0") < notional + fee) throw new ConvertError("INSUFFICIENT_FUNDS");
  }
  const id = crypto.randomUUID();
  const expires = new Date(Date.now() + QUOTE_MS);
  await pool.query(
    `INSERT INTO convert_quotes (
       id, user_id, symbol, side, qty, price_px, touch_px, notional_uusd, fee_uusd,
       spread_bps, slippage_bps, namespace, status, expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'open',$13)`,
    [
      id,
      userId,
      inst.symbol,
      input.side,
      input.qty.toString(),
      price.toString(),
      touchAvg.toString(),
      notional.toString(),
      fee.toString(),
      bps.spread,
      input.slippageBps,
      input.paper ? "paper" : "real",
      expires.toISOString(),
    ],
  );
  return {
    quoteId: id,
    symbol: inst.symbol,
    side: input.side,
    qty: input.qty.toString(),
    price: price.toString(),
    touch: touchAvg.toString(),
    notionalUusd: notional.toString(),
    feeUusd: fee.toString(),
    feeBps: bps.fee,
    spreadBps: bps.spread,
    slippageBps: input.slippageBps,
    priceScale: inst.priceScale,
    qtyScale: inst.qtyScale,
    priceDecimals: inst.priceDecimals,
    qtyDecimals: inst.qtyDecimals,
    namespace: input.paper ? "paper" : "real",
    expiresAt: expires.toISOString(),
    ttlMs: QUOTE_MS,
  };
}

type FillLeg = { price: number; qty: number };

function average(legs: FillLeg[], fallback: bigint): bigint {
  let qty = 0n;
  let notion = 0n;
  for (const leg of legs) {
    const q = BigInt(leg.qty);
    qty += q;
    notion += q * BigInt(Math.round(leg.price));
  }
  return qty > 0n ? notion / qty : fallback;
}

async function takeReal(
  pool: Db,
  engine: EngineClient,
  customer: CustomerRef,
  inst: Instrument,
  side: "buy" | "sell",
  qty: bigint,
  price: bigint,
): Promise<{ filled: bigint; price: bigint; legs: FillLeg[]; external: boolean }> {
  const placed = await placeOrder(pool, engine, customer, {
    side,
    orderType: "ioc",
    priceCents: price,
    qtyMg: qty,
    symbol: inst.symbol,
    lpVenue: "convert",
  });
  const filled = BigInt(placed.filledMg || "0");
  return { filled, price: average(placed.trades, price), legs: placed.trades, external: Boolean(placed.lpExternal) };
}

export async function executeConvert(pool: Db, engine: EngineClient, userId: number, quoteId: string) {
  const row = await pool.query(`SELECT * FROM convert_quotes WHERE id = $1 AND user_id = $2`, [quoteId, userId]);
  if (!row.rowCount) throw new ConvertError("NOT_FOUND");
  const quote = row.rows[0];
  if (quote.status === "filled") {
    const prev = await pool.query(`SELECT * FROM convert_fills WHERE quote_id = $1`, [quoteId]);
    return shapeFill(prev.rows[0]);
  }
  if (quote.status !== "open" || new Date(quote.expires_at).getTime() <= Date.now()) {
    await pool.query(`UPDATE convert_quotes SET status = 'expired' WHERE id = $1 AND status = 'open'`, [quoteId]);
    throw new ConvertError("QUOTE_EXPIRED");
  }
  const paper = quote.namespace === "paper";
  await assertMode(pool, userId, "convert", paper);
  const inst = getInstrument(quote.symbol as string);
  const customer = await tradable(pool, userId, inst);
  const side = quote.side as "buy" | "sell";
  const qty = BigInt(quote.qty);
  const firm = BigInt(quote.price_px);
  const touch = BigInt(quote.touch_px);
  const slippage = Number(quote.slippage_bps);
  const book = await engine.book(inst.symbol);
  if (book.halted) throw new ConvertError("MARKET_HALTED");
  const live = side === "buy" ? book.asks[0] : book.bids[0];
  if (!live) throw new ConvertError("EMPTY_BOOK");
  if (worse(side, BigInt(Math.round(live.price)), touch, slippage)) throw new ConvertError("SLIPPAGE");

  let filled = 0n;
  let avg = firm;
  let path: "ioc" | "principal" = "ioc";
  const legs: FillLeg[] = [];

  if (paper) {
    const placed = await placePaperOrder(pool, engine, userId, {
      side,
      orderType: "ioc",
      price: firm,
      qty,
      symbol: inst.symbol,
    });
    filled = BigInt(placed.filled || "0");
    if (filled === 0n) throw new ConvertError("EMPTY_BOOK");
    const trade = await pool.query(
      `SELECT price_px::text, qty::text FROM paper_trades WHERE order_id = $1`,
      [placed.id],
    );
    for (const item of trade.rows) legs.push({ price: Number(item.price_px), qty: Number(item.qty) });
    avg = average(legs, firm);
  } else {
    const first = await takeReal(pool, engine, customer, inst, side, qty, firm);
    filled = first.filled;
    legs.push(...first.legs);
    if (!first.external && filled < qty) {
      const desk = await loadBot(pool, "bot-mm@internal.meridex");
      const rest = qty - filled;
      if (desk && rest > 0n) {
        let deskId: string | null = null;
        try {
          const posted = await placeOrder(pool, engine, desk, {
            side: side === "buy" ? "sell" : "buy",
            orderType: "limit",
            priceCents: firm,
            qtyMg: rest,
            symbol: inst.symbol,
          });
          deskId = posted.orderId;
          const second = await takeReal(pool, engine, customer, inst, side, rest, firm);
          filled += second.filled;
          legs.push(...second.legs);
          const used = await pool.query(`SELECT filled_mg::text FROM user_orders WHERE engine_order_id = $1`, [posted.orderId]);
          if (BigInt((used.rows[0]?.filled_mg as string | undefined) ?? "0") > 0n) path = "principal";
        } catch (err) {
          if (filled === 0n) throw err;
        } finally {
          if (deskId) {
            try {
              await cancelOrder(pool, engine, desk, deskId);
            } catch {
              /* already filled or gone */
            }
          }
        }
      }
    }
    if (filled === 0n) throw new ConvertError("EMPTY_BOOK");
    avg = average(legs, firm);
  }

  const notional = quoteNotional(filled, avg, inst);
  const quotedFee = BigInt(quote.fee_uusd);
  let fee = qty > 0n ? (quotedFee * filled) / qty : 0n;
  if (paper) {
    if (fee > 0n) {
      try {
        await chargePaperUsd(pool, userId, fee);
      } catch {
        fee = 0n;
      }
    }
  } else if (fee > 0n) {
    const desk = await loadBot(pool, "bot-mm@internal.meridex");
    if (desk) {
      try {
        await withTx(pool, (client) => moveAvailable(client, customer, desk, inst.quote, fee, "convert_fee", quoteId));
      } catch {
        fee = 0n;
      }
    }
  }
  await pool.query(`UPDATE convert_quotes SET status = 'filled' WHERE id = $1`, [quoteId]);
  const inserted = await pool.query(
    `INSERT INTO convert_fills (quote_id, user_id, symbol, side, qty, price_px, notional_uusd, fee_uusd, path, namespace)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [quoteId, userId, inst.symbol, side, filled.toString(), avg.toString(), notional.toString(), fee.toString(), path, quote.namespace],
  );
  return shapeFill(inserted.rows[0]);
}

function shapeFill(row: Record<string, unknown> | undefined) {
  if (!row) throw new ConvertError("NOT_FOUND");
  return {
    quoteId: row.quote_id,
    symbol: row.symbol,
    side: row.side,
    filled: String(row.qty),
    price: String(row.price_px),
    notionalUusd: String(row.notional_uusd),
    feeUusd: String(row.fee_uusd),
    path: row.path,
    namespace: row.namespace,
    status: "filled",
    createdAt: row.created_at,
  };
}

export async function convertHistory(pool: Db, userId: number) {
  const rows = await pool.query(
    `SELECT quote_id, symbol, side, qty::text, price_px::text, notional_uusd::text, fee_uusd::text, path, namespace, created_at
     FROM convert_fills WHERE user_id = $1 ORDER BY id DESC LIMIT 40`,
    [userId],
  );
  return {
    fills: rows.rows.map((row) => ({
      quoteId: row.quote_id,
      symbol: row.symbol,
      side: row.side,
      filled: row.qty,
      price: row.price_px,
      notionalUusd: row.notional_uusd,
      feeUusd: row.fee_uusd,
      path: row.path,
      namespace: row.namespace,
      createdAt: row.created_at,
    })),
  };
}

export function asConvertError(err: unknown): { code: string } | null {
  if (err instanceof ConvertError || err instanceof ModeError) return err;
  if (err instanceof PaperReject) return new ConvertError(err.code);
  if (err instanceof LedgerError) {
    if (err.code === "INSUFFICIENT_FUNDS" || err.code === "INSUFFICIENT_GOLD" || err.code === "INSUFFICIENT_BALANCE") {
      return new ConvertError(err.code === "INSUFFICIENT_GOLD" ? "INSUFFICIENT_GOLD" : "INSUFFICIENT_FUNDS");
    }
    return new ConvertError(err.code);
  }
  return null;
}
