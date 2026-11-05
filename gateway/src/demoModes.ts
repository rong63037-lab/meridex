import type { Db } from "./db.js";
import { withTx } from "./db.js";
import type { EngineClient } from "./engineClient.js";
import { getInstrument, quoteNotional } from "./instruments.js";
import { ModeError, assertMode } from "./modes.js";
import { PaperReject, paperEnabled, paperUsdAvailable } from "./paper.js";

export class DemoError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

const PERPS = [
  { symbol: "XAU-PERP", spot: "XAU/USD" },
  { symbol: "BTC-PERP", spot: "BTC/USD" },
  { symbol: "ETH-PERP", spot: "ETH/USD" },
] as const;

const FUNDING_BPS = 1;
const FUNDING_MS = 8 * 60 * 60 * 1000;

export const COPY_LEADERS = [
  {
    id: "jin-heng",
    nameZh: "金衡一号",
    nameEn: "Jin Heng One",
    nameMs: "Jin Heng Satu",
    styleZh: "现货黄金均值",
    styleEn: "Gold mean reversion",
    styleMs: "Min emas",
    winRate: 0.58,
    drawdown: 0.072,
  },
  {
    id: "echo-two",
    nameZh: "回声乙",
    nameEn: "Echo Two",
    nameMs: "Gema Dua",
    styleZh: "金银比",
    styleEn: "Gold-silver ratio",
    styleMs: "Nisbah emas-perak",
    winRate: 0.54,
    drawdown: 0.11,
  },
  {
    id: "north-three",
    nameZh: "北向丙",
    nameEn: "North Three",
    nameMs: "Utara Tiga",
    styleZh: "趋势跟随",
    styleEn: "Trend following",
    styleMs: "Ikut trend",
    winRate: 0.51,
    drawdown: 0.16,
  },
] as const;

function curve(seed: number): number[] {
  const out: number[] = [];
  let v = 100;
  for (let i = 0; i < 32; i++) {
    const wave = Math.sin(i / 3 + seed) * 1.4;
    v += 0.35 + wave * 0.25;
    out.push(Math.round(v * 100) / 100);
  }
  return out;
}

async function requirePaper(pool: Db, userId: number, mode: "margin" | "perp" | "copy") {
  if (!(await paperEnabled(pool, userId))) throw new DemoError("DEMO_ONLY");
  await assertMode(pool, userId, mode, true);
}

async function markOf(engine: EngineClient, spot: string): Promise<{ mark: bigint; index: bigint }> {
  const book = await engine.book(spot);
  const bid = book.bids[0]?.price ?? 0;
  const ask = book.asks[0]?.price ?? 0;
  const index = BigInt(Math.round(book.reference_price || book.last_trade_price || 0));
  const mark = bid && ask ? BigInt(Math.round((bid + ask) / 2)) : index;
  return { mark, index };
}

export async function marginView(pool: Db, engine: EngineClient, userId: number) {
  let blocked: string | null = null;
  try {
    await assertMode(pool, userId, "margin", true);
  } catch (err) {
    if (!(err instanceof ModeError)) throw err;
    blocked = err.code;
  }
  const row = await pool.query(`SELECT mode, leverage, borrowed_uusd::text FROM paper_margin WHERE user_id = $1`, [userId]);
  const borrowed = BigInt((row.rows[0]?.borrowed_uusd as string | undefined) ?? "0");
  const usd = await paperUsdAvailable(pool, userId);
  const xauRow = await pool.query(
    `SELECT available::text FROM paper_balances WHERE user_id = $1 AND asset = 'XAU'`,
    [userId],
  );
  const xau = BigInt((xauRow.rows[0]?.available as string | undefined) ?? "0");
  const { mark } = await markOf(engine, "XAU/USD").catch(() => ({ mark: 0n, index: 0n }));
  const inst = getInstrument("XAU/USD");
  const xauUsd = mark > 0n ? quoteNotional(xau, mark, inst) : 0n;
  const equity = usd + xauUsd - borrowed;
  const ratio = borrowed > 0n ? Number(equity) / Number(borrowed) : null;
  let liquidation: string | null = null;
  if (borrowed > 0n && xau > 0n) {
    const need = (borrowed * 11n) / 10n - usd;
    if (need > 0n) {
      const px = (need * BigInt(inst.qtyScale) * BigInt(inst.priceScale)) / (xau * BigInt(inst.quoteScale));
      liquidation = px > 0n ? px.toString() : null;
    }
  }
  const country = await pool.query(`SELECT residence_country FROM kyc_profiles WHERE user_id = $1`, [userId]);
  return {
    paper: true,
    licence: "required",
    badge: "需牌照，暂未开放 · 模拟",
    blocked,
    usHard: blocked === "US_RETAIL_BLOCK" || country.rows[0]?.residence_country === "US",
    mode: (row.rows[0]?.mode as string | undefined) ?? "cross",
    leverage: Number(row.rows[0]?.leverage ?? 2),
    borrowedUusd: borrowed.toString(),
    equityUusd: equity.toString(),
    marginRatio: ratio,
    liquidationPrice: liquidation,
    mark: mark.toString(),
  };
}

export async function setMargin(
  pool: Db,
  userId: number,
  input: { mode?: "cross" | "isolated"; leverage?: number },
) {
  await requirePaper(pool, userId, "margin");
  const leverage = input.leverage ?? 2;
  if (leverage < 1 || leverage > 10) throw new DemoError("VALIDATION");
  const mode = input.mode ?? "cross";
  await pool.query(
    `INSERT INTO paper_margin (user_id, mode, leverage, borrowed_uusd) VALUES ($1,$2,$3,0)
     ON CONFLICT (user_id) DO UPDATE SET mode = EXCLUDED.mode, leverage = EXCLUDED.leverage`,
    [userId, mode, leverage],
  );
  return { mode, leverage };
}

export async function borrowMargin(pool: Db, userId: number, amount: bigint) {
  await requirePaper(pool, userId, "margin");
  if (amount <= 0n) throw new DemoError("VALIDATION");
  await withTx(pool, async (client) => {
    await client.query(
      `INSERT INTO paper_margin (user_id, mode, leverage, borrowed_uusd) VALUES ($1,'cross',2,0)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    await client.query(
      `INSERT INTO paper_balances (user_id, asset, available, reserved) VALUES ($1,'USD',0,0)
       ON CONFLICT (user_id, asset) DO NOTHING`,
      [userId],
    );
    await client.query(`UPDATE paper_margin SET borrowed_uusd = borrowed_uusd + $2::bigint WHERE user_id = $1`, [
      userId,
      amount.toString(),
    ]);
    await client.query(`UPDATE paper_balances SET available = available + $2::bigint WHERE user_id = $1 AND asset = 'USD'`, [
      userId,
      amount.toString(),
    ]);
  });
  return { borrowed: amount.toString() };
}

export async function repayMargin(pool: Db, userId: number, amount: bigint) {
  await requirePaper(pool, userId, "margin");
  if (amount <= 0n) throw new DemoError("VALIDATION");
  await withTx(pool, async (client) => {
    const row = await client.query(`SELECT borrowed_uusd::text FROM paper_margin WHERE user_id = $1 FOR UPDATE`, [userId]);
    const borrowed = BigInt((row.rows[0]?.borrowed_uusd as string | undefined) ?? "0");
    const bal = await client.query(
      `SELECT available::text FROM paper_balances WHERE user_id = $1 AND asset = 'USD' FOR UPDATE`,
      [userId],
    );
    const have = BigInt((bal.rows[0]?.available as string | undefined) ?? "0");
    const pay = [amount, borrowed, have].reduce((a, b) => (a < b ? a : b));
    if (pay <= 0n) throw new DemoError("INSUFFICIENT_FUNDS");
    await client.query(`UPDATE paper_margin SET borrowed_uusd = borrowed_uusd - $2::bigint WHERE user_id = $1`, [userId, pay.toString()]);
    await client.query(`UPDATE paper_balances SET available = available - $2::bigint WHERE user_id = $1 AND asset = 'USD'`, [
      userId,
      pay.toString(),
    ]);
  });
  return { ok: true };
}

export async function perpBoard(pool: Db, engine: EngineClient, userId: number) {
  const access = await assertMode(pool, userId, "perp", true).then(() => "allow").catch((err: unknown) => {
    if (err instanceof ModeError) return err.code;
    throw err;
  });
  const markets = [];
  for (const item of PERPS) {
    const px = await markOf(engine, item.spot).catch(() => ({ mark: 0n, index: 0n }));
    const next = Math.ceil(Date.now() / FUNDING_MS) * FUNDING_MS;
    markets.push({
      symbol: item.symbol,
      spot: item.spot,
      mark: px.mark.toString(),
      index: px.index.toString(),
      fundingBps: FUNDING_BPS,
      fundingAt: new Date(next).toISOString(),
    });
  }
  const positions = await pool.query(
    `SELECT id::text, symbol, side, qty::text, entry_px::text, leverage, margin_uusd::text, tp_px::text, sl_px::text, status, realized_uusd::text, created_at
     FROM paper_perps WHERE user_id = $1 ORDER BY id DESC LIMIT 30`,
    [userId],
  );
  return { paper: true, licence: "required", access, markets, positions: positions.rows };
}

export async function openPerp(
  pool: Db,
  engine: EngineClient,
  userId: number,
  input: { symbol: string; side: "buy" | "sell"; qty: bigint; leverage: number; tp: bigint | null; sl: bigint | null },
) {
  await requirePaper(pool, userId, "perp");
  const spec = PERPS.find((item) => item.symbol === input.symbol);
  if (!spec) throw new DemoError("UNKNOWN_SYMBOL");
  if (input.leverage < 1 || input.leverage > 10 || input.qty <= 0n) throw new DemoError("VALIDATION");
  const inst = getInstrument(spec.spot);
  if (input.qty < BigInt(inst.minQty)) throw new DemoError("VALIDATION");
  const { mark } = await markOf(engine, spec.spot);
  if (mark <= 0n) throw new DemoError("EMPTY_BOOK");
  const notional = quoteNotional(input.qty, mark, inst);
  const margin = notional / BigInt(input.leverage);
  if (margin <= 0n) throw new DemoError("VALIDATION");
  const have = await paperUsdAvailable(pool, userId);
  if (have < margin) throw new DemoError("INSUFFICIENT_FUNDS");
  await pool.query(`UPDATE paper_balances SET available = available - $2::bigint WHERE user_id = $1 AND asset = 'USD'`, [
    userId,
    margin.toString(),
  ]);
  const row = await pool.query(
    `INSERT INTO paper_perps (user_id, symbol, side, qty, entry_px, leverage, margin_uusd, tp_px, sl_px, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open') RETURNING id::text`,
    [
      userId,
      spec.symbol,
      input.side,
      input.qty.toString(),
      mark.toString(),
      input.leverage,
      margin.toString(),
      input.tp?.toString() ?? null,
      input.sl?.toString() ?? null,
    ],
  );
  return { id: row.rows[0].id as string, entry: mark.toString(), marginUusd: margin.toString(), status: "open" };
}

export async function closePerp(pool: Db, engine: EngineClient, userId: number, id: string) {
  await requirePaper(pool, userId, "perp");
  const row = await pool.query(`SELECT * FROM paper_perps WHERE id = $1 AND user_id = $2 AND status = 'open'`, [id, userId]);
  if (!row.rowCount) throw new DemoError("NOT_FOUND");
  const pos = row.rows[0];
  const spec = PERPS.find((item) => item.symbol === pos.symbol);
  if (!spec) throw new DemoError("UNKNOWN_SYMBOL");
  const { mark } = await markOf(engine, spec.spot);
  const pnl = perpPnl(spec.spot, pos.side as string, BigInt(pos.qty), BigInt(pos.entry_px), mark);
  const margin = BigInt(pos.margin_uusd);
  const back = margin + pnl > 0n ? margin + pnl : 0n;
  await pool.query(`UPDATE paper_balances SET available = available + $2::bigint WHERE user_id = $1 AND asset = 'USD'`, [
    userId,
    back.toString(),
  ]);
  await pool.query(`UPDATE paper_perps SET status = 'closed', realized_uusd = $2 WHERE id = $1`, [id, pnl.toString()]);
  return { id, status: "closed", pnlUusd: pnl.toString() };
}

function perpPnl(spot: string, side: string, qty: bigint, entry: bigint, mark: bigint): bigint {
  const inst = getInstrument(spot);
  const up = quoteNotional(qty, mark, inst) - quoteNotional(qty, entry, inst);
  return side === "buy" ? up : -up;
}

export async function settlePaperPerps(pool: Db, engine: EngineClient) {
  const open = await pool.query(
    `SELECT id::text, user_id, symbol, side, qty::text, entry_px::text, margin_uusd::text, tp_px::text, sl_px::text
     FROM paper_perps WHERE status = 'open' ORDER BY id LIMIT 40`,
  );
  for (const row of open.rows) {
    const spec = PERPS.find((item) => item.symbol === row.symbol);
    if (!spec) continue;
    let mark = 0n;
    try {
      mark = (await markOf(engine, spec.spot)).mark;
    } catch {
      continue;
    }
    const side = row.side as string;
    const pnl = perpPnl(spec.spot, side, BigInt(row.qty), BigInt(row.entry_px), mark);
    const margin = BigInt(row.margin_uusd);
    const tp = row.tp_px ? BigInt(row.tp_px) : null;
    const sl = row.sl_px ? BigInt(row.sl_px) : null;
    const hitTp = tp != null && (side === "buy" ? mark >= tp : mark <= tp);
    const hitSl = sl != null && (side === "buy" ? mark <= sl : mark >= sl);
    const liquidate = pnl < 0n && -pnl >= (margin * 9n) / 10n;
    if (!hitTp && !hitSl && !liquidate) continue;
    const back = margin + pnl > 0n ? margin + pnl : 0n;
    await pool.query(`UPDATE paper_balances SET available = available + $2::bigint WHERE user_id = $1 AND asset = 'USD'`, [
      row.user_id,
      back.toString(),
    ]);
    await pool.query(`UPDATE paper_perps SET status = $2, realized_uusd = $3 WHERE id = $1`, [
      row.id,
      liquidate ? "liquidated" : "closed",
      pnl.toString(),
    ]);
  }
}

export function copyLeaders() {
  return COPY_LEADERS.map((leader, index) => ({
    ...leader,
    fictional: true,
    curve: curve(index + 1),
  }));
}

export async function followLeader(
  pool: Db,
  engine: EngineClient,
  userId: number,
  input: { leaderId: string; allocationUusd: bigint; maxDrawdownBps: number },
) {
  await requirePaper(pool, userId, "copy");
  const leader = COPY_LEADERS.find((item) => item.id === input.leaderId);
  if (!leader) throw new DemoError("NOT_FOUND");
  if (input.allocationUusd <= 0n || input.maxDrawdownBps < 50 || input.maxDrawdownBps > 3000) throw new DemoError("VALIDATION");
  const have = await paperUsdAvailable(pool, userId);
  if (have < input.allocationUusd) throw new DemoError("INSUFFICIENT_FUNDS");
  await pool.query(
    `INSERT INTO paper_copy_follows (user_id, leader_id, allocation_uusd, max_drawdown_bps, status)
     VALUES ($1,$2,$3,$4,'active')
     ON CONFLICT (user_id, leader_id) DO UPDATE
       SET allocation_uusd = EXCLUDED.allocation_uusd, max_drawdown_bps = EXCLUDED.max_drawdown_bps, status = 'active'`,
    [userId, leader.id, input.allocationUusd.toString(), input.maxDrawdownBps],
  );
  return copyOnce(pool, engine, userId, leader.id);
}

export async function copyOnce(pool: Db, engine: EngineClient, userId: number, leaderId: string) {
  await requirePaper(pool, userId, "copy");
  const follow = await pool.query(
    `SELECT allocation_uusd::text, status FROM paper_copy_follows WHERE user_id = $1 AND leader_id = $2`,
    [userId, leaderId],
  );
  if (!follow.rowCount || follow.rows[0].status !== "active") throw new DemoError("NOT_FOUND");
  const inst = getInstrument("XAU/USD");
  const { mark } = await markOf(engine, "XAU/USD");
  const budget = BigInt(follow.rows[0].allocation_uusd as string) / 20n;
  const qty = (budget * BigInt(inst.qtyScale) * BigInt(inst.priceScale)) / (mark * BigInt(inst.quoteScale));
  const size = qty < BigInt(inst.minQty) ? BigInt(inst.minQty) : qty;
  const notional = quoteNotional(size, mark, inst);
  const have = await paperUsdAvailable(pool, userId);
  if (have < notional) throw new DemoError("INSUFFICIENT_FUNDS");
  const side = "buy";
  await pool.query(`UPDATE paper_balances SET available = available - $2::bigint WHERE user_id = $1 AND asset = 'USD'`, [
    userId,
    notional.toString(),
  ]);
  await pool.query(
    `INSERT INTO paper_balances (user_id, asset, available, reserved) VALUES ($1,'XAU',$2,0)
     ON CONFLICT (user_id, asset) DO UPDATE SET available = paper_balances.available + EXCLUDED.available`,
    [userId, size.toString()],
  );
  await pool.query(
    `INSERT INTO paper_copy_trades (user_id, leader_id, symbol, side, qty, price_px) VALUES ($1,$2,'XAU/USD',$3,$4,$5)`,
    [userId, leaderId, side, size.toString(), mark.toString()],
  );
  return { leaderId, side, qty: size.toString(), price: mark.toString(), fictional: true };
}

export async function copyState(pool: Db, userId: number) {
  const follows = await pool.query(
    `SELECT leader_id, allocation_uusd::text, max_drawdown_bps, status FROM paper_copy_follows WHERE user_id = $1`,
    [userId],
  );
  const trades = await pool.query(
    `SELECT id::text, leader_id, symbol, side, qty::text, price_px::text, created_at
     FROM paper_copy_trades WHERE user_id = $1 ORDER BY id DESC LIMIT 30`,
    [userId],
  );
  return { follows: follows.rows, trades: trades.rows, leaders: copyLeaders() };
}

export function asDemoError(err: unknown): DemoError | null {
  if (err instanceof DemoError) return err;
  if (err instanceof ModeError) return new DemoError(err.code);
  if (err instanceof PaperReject) return new DemoError(err.code);
  return null;
}
