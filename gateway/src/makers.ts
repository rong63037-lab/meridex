import type { Db } from "./db.js";
import { withTx } from "./db.js";
import type { EngineClient } from "./engineClient.js";
import { quoteMid, startFeedLoop } from "./feeds.js";
import { loadCatalog, type Instrument } from "./instruments.js";
import { deposit, type CustomerRef } from "./ledger.js";
import { quietWarn, sleep, transientNet } from "./net.js";
import { cancelOrder, placeOrder } from "./trading.js";

const LEVELS = 14;

/** Human-unit size of one level, [tight, deep]. BTC and ETH match the dealing depth we show. */
const BASE_RANGE: Record<string, [number, number]> = {
  BTC: [0.05, 2],
  ETH: [1, 30],
  SOL: [8, 250],
  XRP: [200, 8000],
  BNB: [0.5, 20],
  DOGE: [400, 20000],
  LTC: [1, 40],
  BCH: [0.4, 15],
  XAG: [20, 800],
  XPT: [0.5, 15],
  XPD: [0.5, 15],
  XAU: [8, 20],
  XAUKG: [1, 2],
  XAUOZ: [1, 20],
  BRENT: [2, 40],
  WTI: [2, 40],
  NATGAS: [5, 80],
  COPPER: [1, 20],
  ALUMINIUM: [1, 20],
  NICKEL: [0.2, 4],
  ZINC: [1, 15],
  WHEAT: [5, 80],
  CORN: [5, 80],
  SOYBEAN: [2, 40],
  COFFEE: [2, 40],
  SUGAR: [5, 100],
};

function rangeFor(inst: Instrument): [number, number] {
  if (BASE_RANGE[inst.base]) return BASE_RANGE[inst.base];
  const usd = inst.category === "fx" ? [2_000, 40_000] : inst.category === "crypto" ? [400, 12_000] : [800, 15_000];
  const px = inst.refPrice / inst.priceScale;
  if (px <= 0) return [inst.minQty / inst.qtyScale, inst.minQty / inst.qtyScale];
  return [usd[0] / px, usd[1] / px];
}

function levelQty(inst: Instrument, level: number): bigint {
  const [lo, hi] = rangeFor(inst);
  const t = LEVELS <= 1 ? 0 : level / (LEVELS - 1);
  const units = (lo + (hi - lo) * (0.15 + 0.85 * t)) * (0.75 + Math.random() * 0.5);
  const min = BigInt(inst.minQty);
  let qty = BigInt(Math.max(1, Math.round(units * inst.qtyScale)));
  if (qty < min) qty = min;
  qty = (qty / min) * min;
  const cap = 1_000_000_000_000n;
  return qty > cap ? cap : qty;
}

function targetBase(inst: Instrument): bigint {
  const [, hi] = rangeFor(inst);
  const min = BigInt(inst.minQty);
  let qty = BigInt(Math.max(1, Math.round(Math.min(hi * inst.qtyScale, 1e12)))) * BigInt(LEVELS);
  if (qty < min) qty = min;
  const cap = 1_000_000_000_000n;
  return qty > cap ? cap : qty;
}

async function position(pool: Db, userId: number, asset: string): Promise<bigint> {
  const row = await pool.query(
    `SELECT COALESCE(SUM(b.amount), 0)::text AS n
     FROM accounts a JOIN balances b ON b.account_id = a.id
     WHERE a.customer_id = $1 AND a.asset = $2 AND a.bucket IN ('available', 'reserved')`,
    [userId, asset],
  );
  return BigInt(row.rows[0]?.n ?? "0");
}

async function topUp(pool: Db, user: CustomerRef, asset: string, need: bigint): Promise<void> {
  if (need <= 0n) return;
  const have = await position(pool, user.id, asset);
  if (have >= need) return;
  await withTx(pool, (client) => deposit(client, user, asset, need - have));
}

/** Give each bot enough inventory to show a full ladder, including after a restart. */
export async function ensureFloats(pool: Db, bots: CustomerRef[], demo: CustomerRef | null): Promise<void> {
  const catalog = loadCatalog();
  const usdNeed = 20_000_000n * 1_000_000n;
  for (const bot of bots) {
    await topUp(pool, bot, "USD", usdNeed);
    for (const inst of catalog) {
      if (inst.base === "USD") continue;
      await topUp(pool, bot, inst.base, targetBase(inst));
    }
  }
  if (!demo) return;
  const starter: Record<string, string> = { "BTC/USD": "BTC", "ETH/USD": "ETH", "XAG/USD": "XAG", "USDT/USD": "USDT", "BRENT/USD": "BRENT" };
  for (const [symbol, asset] of Object.entries(starter)) {
    const inst = catalog.find((row) => row.symbol === symbol);
    if (!inst) continue;
    const [, hi] = rangeFor(inst);
    const qty = BigInt(Math.max(inst.minQty, Math.round(hi * 0.05 * inst.qtyScale)));
    await topUp(pool, demo, asset, qty);
  }
}

function ladder(mid: number, tick: number, haltLow: number, haltHigh: number): { bids: number[]; asks: number[] } {
  const bids: number[] = [];
  const asks: number[] = [];
  let bid = mid - tick;
  let ask = mid + tick;
  for (let i = 0; i < LEVELS; i++) {
    const step = tick * (1 + Math.floor(i / 5));
    if (bid > haltLow) bids.push(bid);
    if (ask < haltHigh) asks.push(ask);
    bid -= step;
    ask += step;
  }
  if (bids.length < 10 || asks.length < 10) {
    bids.length = 0;
    asks.length = 0;
    for (let i = 1; i <= LEVELS; i++) {
      const b = mid - tick * i;
      const a = mid + tick * i;
      if (b > haltLow) bids.push(b);
      if (a < haltHigh) asks.push(a);
    }
  }
  return { bids, asks };
}

/** Keep a two-sided book when someone else's bid sits above the new mid. */
function uncrossed(mid: number, tick: number, haltLow: number, haltHigh: number, bestBid: number, bestAsk: number): { bids: number[]; asks: number[] } {
  const prices = ladder(mid, tick, haltLow, haltHigh);
  const bidCap = Number.isFinite(bestAsk) ? bestAsk - tick : haltHigh;
  const askFloor = bestBid > 0 ? bestBid + tick : mid + tick;
  let bids = prices.bids.filter((px) => px <= bidCap && px > haltLow);
  let asks = prices.asks.filter((px) => px >= askFloor && px < haltHigh);
  if (asks.length < 10 && askFloor < haltHigh) {
    asks = [];
    for (let i = 0; i < LEVELS; i++) {
      const px = askFloor + tick * i;
      if (px >= haltHigh) break;
      asks.push(px);
    }
  }
  if (bids.length < 10 && bidCap > haltLow) {
    bids = [];
    for (let i = 0; i < LEVELS; i++) {
      const px = bidCap - tick * i;
      if (px <= haltLow) break;
      bids.push(px);
    }
  }
  return { bids, asks };
}

async function restLadder(pool: Db, engine: EngineClient, mm: CustomerRef, inst: Instrument, mid: number): Promise<void> {
  await cancelMine(pool, engine, mm, inst.symbol);
  const live = await engine.book(inst.symbol);
  if (live.halted) return;
  const tick = Math.max(1, inst.tickSize);
  const prices = uncrossed(mid, tick, live.halt_low, live.halt_high, live.bids[0]?.price ?? 0, live.asks[0]?.price ?? Number.POSITIVE_INFINITY);
  for (let i = 0; i < prices.bids.length; i++) {
    await placeOrder(pool, engine, mm, {
      side: "buy",
      orderType: "post_only",
      priceCents: BigInt(prices.bids[i]),
      qtyMg: levelQty(inst, i),
      symbol: inst.symbol,
    }).catch(() => undefined);
  }
  for (let i = 0; i < prices.asks.length; i++) {
    await placeOrder(pool, engine, mm, {
      side: "sell",
      orderType: "post_only",
      priceCents: BigInt(prices.asks[i]),
      qtyMg: levelQty(inst, i),
      symbol: inst.symbol,
    }).catch(() => undefined);
  }
}

async function cancelMine(pool: Db, engine: EngineClient, mm: CustomerRef, symbol: string): Promise<void> {
  const open = await pool.query(
    `SELECT engine_order_id FROM user_orders WHERE user_id = $1 AND status = 'open' AND symbol = $2`,
    [mm.id, symbol],
  );
  for (const row of open.rows) {
    await cancelOrder(pool, engine, mm, row.engine_order_id as string).catch(() => undefined);
  }
}

async function pullOutside(pool: Db, engine: EngineClient, symbol: string, lo: number, hi: number): Promise<number> {
  const open = await pool.query(
    `SELECT uo.engine_order_id, uo.price_cents::text AS price_cents, u.id, u.entity_id, u.jurisdiction
     FROM user_orders uo JOIN users u ON u.id = uo.user_id
     WHERE uo.symbol = $1 AND uo.status = 'open'`,
    [symbol],
  );
  let pulled = 0;
  for (const row of open.rows) {
    const px = Number(row.price_cents);
    if (px >= lo && px <= hi) continue;
    const owner: CustomerRef = { id: Number(row.id), entityId: row.entity_id as string, jurisdiction: row.jurisdiction as string };
    await cancelOrder(pool, engine, owner, row.engine_order_id as string).catch(() => undefined);
    pulled += 1;
  }
  return pulled;
}

let tradeFlip = 0;

async function quoteBook(pool: Db, engine: EngineClient, mm: CustomerRef, flow: CustomerRef, inst: Instrument, trade: boolean): Promise<void> {
  const book = await engine.book(inst.symbol);
  const tick = Math.max(1, inst.tickSize);
  const mid = quoteMid(inst);
  const haltHalf = Math.floor(book.reference_price * book.halt_bps / 10_000);
  const drifted = Math.abs(mid - book.reference_price) > Math.max(tick * 4, Math.floor(haltHalf / 4));
  const outside = mid <= book.halt_low || mid >= book.halt_high;
  if (drifted || outside || book.halted) {
    const nextLo = Math.floor(mid * (10_000 - book.halt_bps) / 10_000);
    const nextHi = Math.floor(mid * (10_000 + book.halt_bps) / 10_000);
    await cancelMine(pool, engine, mm, inst.symbol);
    await pullOutside(pool, engine, inst.symbol, nextLo, nextHi);
    await engine.command({ type: "set_reference", price: mid }, inst.symbol);
    if (book.halted) await engine.command({ type: "resume" }, inst.symbol).catch(() => undefined);
  }
  const live = await engine.book(inst.symbol);
  if (live.halted) return;
  const openN = await pool.query(
    `SELECT count(*)::int AS n FROM user_orders WHERE user_id = $1 AND status = 'open' AND symbol = $2`,
    [mm.id, inst.symbol],
  );
  const thin = Number(openN.rows[0].n) < LEVELS * 2 - 2;
  if (thin || drifted || outside) await restLadder(pool, engine, mm, inst, mid);
  if (!trade) return;
  const fresh = await engine.book(inst.symbol);
  const bestBid = fresh.bids[0];
  const bestAsk = fresh.asks[0];
  if (!bestBid || !bestAsk) return;
  tradeFlip += 1;
  const buy = tradeFlip % 2 === 0;
  const top = buy ? bestAsk : bestBid;
  const qty = BigInt(Math.max(inst.minQty, Math.round(top.qty * (0.08 + Math.random() * 0.15))));
  const lot = (qty / BigInt(inst.minQty)) * BigInt(inst.minQty);
  await placeOrder(pool, engine, flow, {
    side: buy ? "buy" : "sell",
    orderType: "ioc",
    priceCents: BigInt(top.price),
    qtyMg: lot >= BigInt(inst.minQty) ? lot : BigInt(inst.minQty),
    symbol: inst.symbol,
  }).catch(() => undefined);
  const after = await engine.book(inst.symbol);
  const touched = buy ? after.asks[0] : after.bids[0];
  const floorQty = Number(levelQty(inst, 0)) * 0.45;
  if (!touched || touched.qty < floorQty) await restLadder(pool, engine, mm, inst, mid);
}

function tradingBooks(): Instrument[] {
  return loadCatalog().filter((row) => row.status === "trading");
}

/** Centre every book on the live anchor and rest a full ladder before the process accepts orders. */
export async function primeBooks(pool: Db, engine: EngineClient, mm: CustomerRef, flow: CustomerRef): Promise<void> {
  const books = tradingBooks();
  for (const inst of books) {
    try {
      await quoteBook(pool, engine, mm, flow, inst, false);
    } catch (err) {
      console.error("prime", inst.symbol, err);
    }
  }
  console.log(`primed books=${books.length} levels=${LEVELS}`);
}

async function quoteRetry(pool: Db, engine: EngineClient, mm: CustomerRef, flow: CustomerRef, inst: Instrument): Promise<void> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      await quoteBook(pool, engine, mm, flow, inst, true);
      return;
    } catch (err) {
      last = err;
      if (!transientNet(err) || i === 2) throw err;
      await sleep(120 * (i + 1));
    }
  }
  throw last;
}

export function startMakers(pool: Db, engine: EngineClient, mm: CustomerRef, flow: CustomerRef, after: () => Promise<void>): void {
  const books = tradingBooks();
  const btc = books.find((row) => row.symbol === "BTC/USD");
  const xau = books.find((row) => row.symbol === "XAU/USD");
  let cursor = 0;
  let running = false;
  let failStreak = 0;
  let quietUntil = 0;
  const tick = async () => {
    if (running || Date.now() < quietUntil) return;
    running = true;
    try {
      const inst = books[cursor % books.length];
      cursor += 1;
      await quoteRetry(pool, engine, mm, flow, inst);
      if (btc && inst.symbol !== "BTC/USD" && cursor % 2 === 0) {
        await quoteRetry(pool, engine, mm, flow, btc);
      }
      if (xau && inst.symbol !== "XAU/USD" && cursor % 2 === 1) {
        await quoteRetry(pool, engine, mm, flow, xau);
      }
      await after();
      failStreak = 0;
    } catch (err) {
      failStreak += 1;
      const wait = Math.min(20_000, 400 * 2 ** Math.min(failStreak, 5));
      quietUntil = Date.now() + wait;
      const message = err instanceof Error ? err.message : "unavailable";
      quietWarn("maker", `maker backing off ${wait}ms (${message})`);
    } finally {
      running = false;
    }
  };
  setInterval(() => void tick(), 1500);
  startFeedLoop();
}
