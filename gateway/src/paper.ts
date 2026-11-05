/** Simulated balances. Never calls the matching engine or the ledger. */
import type { Db } from "./db.js";
import { withTx } from "./db.js";
import type { EngineClient } from "./engineClient.js";
import { loadDayStats, type DayStat } from "./candles.js";
import { getInstrument, loadCatalog, quoteNotional, type Instrument } from "./instruments.js";

export const PAPER_SEED_UUSD = 100_000n * 1_000_000n;

export class PaperReject extends Error {
  constructor(public code: string) {
    super(code);
  }
}

type Holding = { asset: string; available: bigint; reserved: bigint };

type PaperOrderInput = {
  side: "buy" | "sell";
  orderType: string;
  price: bigint | null;
  qty: bigint;
  symbol: string;
};

export async function paperView(pool: Db, userId: number) {
  const wallet = await pool.query(`SELECT enabled FROM paper_wallets WHERE user_id = $1`, [userId]);
  const balances = await shapePaper(pool, userId);
  return {
    enabled: Boolean(wallet.rows[0]?.enabled),
    seedUusd: PAPER_SEED_UUSD.toString(),
    balances,
  };
}

export async function setPaperEnabled(pool: Db, userId: number, enabled: boolean) {
  if (!enabled) {
    await pool.query(
      `INSERT INTO paper_wallets (user_id, enabled) VALUES ($1, FALSE)
       ON CONFLICT (user_id) DO UPDATE SET enabled = FALSE`,
      [userId],
    );
    return paperView(pool, userId);
  }
  await withTx(pool, async (client) => {
    await client.query(
      `INSERT INTO paper_wallets (user_id, enabled) VALUES ($1, TRUE)
       ON CONFLICT (user_id) DO UPDATE SET enabled = TRUE`,
      [userId],
    );
    const have = await client.query(`SELECT 1 FROM paper_balances WHERE user_id = $1`, [userId]);
    if (!have.rowCount) {
      await client.query(
        `INSERT INTO paper_balances (user_id, asset, available, reserved) VALUES ($1, 'USD', $2, 0)`,
        [userId, PAPER_SEED_UUSD.toString()],
      );
    }
  });
  return paperView(pool, userId);
}

export async function resetPaper(pool: Db, userId: number) {
  await withTx(pool, async (client) => {
    await client.query(`DELETE FROM paper_trades WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM paper_orders WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM paper_balances WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM equity_snapshots WHERE user_id = $1 AND namespace = 'paper'`, [userId]);
    await client.query(
      `INSERT INTO paper_wallets (user_id, enabled, reset_at) VALUES ($1, TRUE, now())
       ON CONFLICT (user_id) DO UPDATE SET enabled = TRUE, reset_at = now()`,
      [userId],
    );
    await client.query(
      `INSERT INTO paper_balances (user_id, asset, available, reserved) VALUES ($1, 'USD', $2, 0)`,
      [userId, PAPER_SEED_UUSD.toString()],
    );
  });
  return paperView(pool, userId);
}

export async function listPaperOrders(pool: Db, userId: number) {
  const rows = await pool.query(
    `SELECT id::text AS engine_order_id, symbol, side, order_type, price_px::text AS price_cents,
            NULL::text AS stop_price_cents, qty::text AS qty_mg, status, reject_reason, created_at
     FROM paper_orders WHERE user_id = $1 ORDER BY id DESC LIMIT 80`,
    [userId],
  );
  return rows.rows;
}

export async function listPaperTrades(pool: Db, userId: number) {
  const rows = await pool.query(
    `SELECT id::text AS engine_trade_id, symbol, price_px::text AS price_cents, qty::text AS qty_mg,
            notional_uusd::text, NULL::text AS fee_uusd, side AS "userSide", created_at AS tape_at
     FROM paper_trades WHERE user_id = $1 ORDER BY id DESC LIMIT 80`,
    [userId],
  );
  return rows.rows;
}

export async function placePaperOrder(pool: Db, engine: EngineClient, userId: number, input: PaperOrderInput) {
  const wallet = await pool.query(`SELECT enabled FROM paper_wallets WHERE user_id = $1`, [userId]);
  if (!wallet.rows[0]?.enabled) throw new PaperReject("PAPER_OFF");
  let inst: Instrument;
  try {
    inst = getInstrument(input.symbol);
  } catch {
    throw new PaperReject("UNKNOWN_SYMBOL");
  }
  if (input.qty <= 0n || input.qty < BigInt(inst.minQty)) throw new PaperReject("VALIDATION");
  const restingType = input.orderType === "stop_limit" || input.orderType === "oco";
  const needsLimit = input.orderType !== "market";
  if (needsLimit && (input.price == null || input.price <= 0n)) throw new PaperReject("VALIDATION");
  if (input.price != null && input.price % BigInt(inst.tickSize) !== 0n) throw new PaperReject("TICK");

  const book = await engine.book(input.symbol);
  if (book.halted) throw new PaperReject("MARKET_HALTED");
  if (input.price != null && (input.price < BigInt(book.band_low) || input.price > BigInt(book.band_high))) {
    throw new PaperReject("PRICE_BAND");
  }

  const touch = input.side === "buy" ? top(book.asks) : top(book.bids);
  const crosses = !restingType && touch != null && (input.orderType === "market" || (input.price != null && (input.side === "buy" ? input.price >= touch.price : input.price <= touch.price)));
  if (input.orderType === "post_only" && crosses) throw new PaperReject("POST_ONLY");

  let fillQty = 0n;
  let fillPx = 0n;
  if (crosses && touch) {
    fillQty = input.qty < touch.qty ? input.qty : touch.qty;
    fillPx = touch.price;
  }
  if ((input.orderType === "fok" || input.orderType === "market" || input.orderType === "ioc") && fillQty < input.qty && input.orderType === "fok") {
    throw new PaperReject("FOK_UNFILLABLE");
  }
  if ((input.orderType === "market" || input.orderType === "ioc") && fillQty === 0n) throw new PaperReject("EMPTY_BOOK");

  const leaveRest = input.orderType !== "market" && input.orderType !== "ioc" && input.orderType !== "fok";
  const leaves = leaveRest ? input.qty - fillQty : 0n;
  const fillNotional = fillQty > 0n ? quoteNotional(fillQty, fillPx, inst) : 0n;
  const restPx = input.price ?? fillPx;
  const restNotional = leaves > 0n && input.side === "buy" ? quoteNotional(leaves, restPx, inst) : 0n;

  return withTx(pool, async (client) => {
    const names = [inst.base, inst.quote].sort();
    const held = new Map<string, Holding>();
    for (const asset of names) held.set(asset, await lockBal(client, userId, asset));
    const quote = held.get(inst.quote)!;
    const base = held.get(inst.base)!;

    if (input.side === "buy") {
      const need = fillNotional + restNotional;
      if (quote.available < need) throw new PaperReject("INSUFFICIENT_FUNDS");
      quote.available -= need;
      quote.reserved += restNotional;
      base.available += fillQty;
    } else {
      if (base.available < input.qty) throw new PaperReject(inst.base === "XAU" ? "INSUFFICIENT_GOLD" : "INSUFFICIENT_BALANCE");
      base.available -= fillQty + leaves;
      base.reserved += leaves;
      quote.available += fillNotional;
    }
    for (const asset of names) {
      const row = held.get(asset)!;
      await client.query(
        `UPDATE paper_balances SET available = $3, reserved = $4 WHERE user_id = $1 AND asset = $2`,
        [userId, asset, row.available.toString(), row.reserved.toString()],
      );
    }

    const status = leaves > 0n ? "open" : fillQty > 0n ? "filled" : "canceled";
    const inserted = await client.query(
      `INSERT INTO paper_orders (user_id, symbol, side, order_type, price_px, qty, leaves, filled, filled_notional, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id::text`,
      [
        userId,
        inst.symbol,
        input.side,
        input.orderType,
        (input.price ?? fillPx).toString(),
        input.qty.toString(),
        leaves.toString(),
        fillQty.toString(),
        fillNotional.toString(),
        status,
      ],
    );
    const id = inserted.rows[0].id as string;
    const trades: { tradeId: string }[] = [];
    if (fillQty > 0n) {
      const trade = await client.query(
        `INSERT INTO paper_trades (user_id, order_id, symbol, side, price_px, qty, notional_uusd)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id::text`,
        [userId, id, inst.symbol, input.side, fillPx.toString(), fillQty.toString(), fillNotional.toString()],
      );
      trades.push({ tradeId: trade.rows[0].id as string });
    }
    return { id, status, rejectReason: null as string | null, filled: fillQty.toString(), trades };
  });
}

export async function cancelPaperOrder(pool: Db, userId: number, id: string) {
  return withTx(pool, async (client) => {
    const row = await client.query(
      `SELECT symbol, side, price_px::text, leaves::text, status
       FROM paper_orders WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [id, userId],
    );
    if (!row.rowCount || row.rows[0].status !== "open") throw new PaperReject("NOT_FOUND");
    const inst = getInstrument(row.rows[0].symbol as string);
    const leaves = BigInt(row.rows[0].leaves);
    const price = BigInt(row.rows[0].price_px);
    const side = row.rows[0].side as string;
    if (side === "buy") {
      const usd = await lockBal(client, userId, inst.quote);
      const release = quoteNotional(leaves, price, inst);
      const give = release < usd.reserved ? release : usd.reserved;
      usd.reserved -= give;
      usd.available += give;
      await client.query(
        `UPDATE paper_balances SET available = $3, reserved = $4 WHERE user_id = $1 AND asset = $2`,
        [userId, inst.quote, usd.available.toString(), usd.reserved.toString()],
      );
    } else {
      const base = await lockBal(client, userId, inst.base);
      const give = leaves < base.reserved ? leaves : base.reserved;
      base.reserved -= give;
      base.available += give;
      await client.query(
        `UPDATE paper_balances SET available = $3, reserved = $4 WHERE user_id = $1 AND asset = $2`,
        [userId, inst.base, base.available.toString(), base.reserved.toString()],
      );
    }
    await client.query(`UPDATE paper_orders SET status = 'canceled', leaves = 0 WHERE id = $1`, [id]);
    return { id, status: "canceled" };
  });
}

export async function cancelAllPaper(pool: Db, userId: number) {
  const open = await pool.query(`SELECT id::text FROM paper_orders WHERE user_id = $1 AND status = 'open'`, [userId]);
  const canceled: string[] = [];
  for (const row of open.rows) {
    await cancelPaperOrder(pool, userId, row.id as string);
    canceled.push(row.id as string);
  }
  return { canceled };
}

export async function portfolioView(pool: Db, userId: number, namespace: "real" | "paper") {
  const stats = await loadDayStats(pool);
  const wallet = await pool.query(`SELECT enabled FROM paper_wallets WHERE user_id = $1`, [userId]);
  const enabled = namespace === "real" || Boolean(wallet.rows[0]?.enabled);
  const holdings = namespace === "paper" ? await paperHoldings(pool, userId) : await realHoldings(pool, userId);
  let equity = 0n;
  let cash = 0n;
  const byCat = new Map<string, bigint>();
  for (const row of holdings) {
    const qty = row.available + row.reserved;
    const usd = markUsd(row.asset, qty, stats);
    equity += usd;
    if (row.asset === "USD") cash += usd;
    const inst = loadCatalog().find((item) => item.base === row.asset && item.quote === "USD");
    const cat = row.asset === "USD" ? "cash" : inst?.category ?? "other";
    if (usd > 0n) byCat.set(cat, (byCat.get(cat) ?? 0n) + usd);
  }

  const today = new Date().toISOString().slice(0, 10);
  await pool.query(
    `INSERT INTO equity_snapshots (user_id, namespace, day, equity_uusd)
     VALUES ($1, $2, $3::date, $4)
     ON CONFLICT (user_id, namespace, day) DO UPDATE SET equity_uusd = EXCLUDED.equity_uusd`,
    [userId, namespace, today, equity.toString()],
  );

  const baseline = namespace === "paper"
    ? (enabled || equity > 0n ? PAPER_SEED_UUSD : 0n)
    : await netUsdDeposits(pool, userId);
  const opened = await pool.query(
    `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day FROM users WHERE id = $1`,
    [userId],
  );
  let start = (opened.rows[0]?.day as string | undefined) ?? today;
  if (start >= today) {
    start = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  }
  if (start !== today) {
    await pool.query(
      `INSERT INTO equity_snapshots (user_id, namespace, day, equity_uusd)
       VALUES ($1, $2, $3::date, $4)
       ON CONFLICT (user_id, namespace, day) DO NOTHING`,
      [userId, namespace, start, (baseline > 0n ? baseline : equity).toString()],
    );
  }

  const curveRows = await pool.query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, equity_uusd::text
     FROM equity_snapshots WHERE user_id = $1 AND namespace = $2 ORDER BY day`,
    [userId, namespace],
  );
  const curve = curveRows.rows.map((row) => ({ day: row.day as string, equityUusd: row.equity_uusd as string }));
  const anchor = baseline > 0n ? baseline : equity;
  const activity = namespace === "paper" ? await paperActivity(pool, userId) : await realActivity(pool, userId);
  return {
    namespace,
    enabled,
    equityUusd: equity.toString(),
    cashUusd: cash.toString(),
    baselineUusd: anchor.toString(),
    pnlUusd: (equity - anchor).toString(),
    curve,
    allocation: [...byCat.entries()].map(([category, usd]) => ({ category, usdUusd: usd.toString() })),
    activity,
  };
}

async function realActivity(pool: Db, userId: number) {
  const rows = await pool.query(
    `SELECT id::text, kind, asset, amount::text, detail, created_at
     FROM activity WHERE user_id = $1 ORDER BY id DESC LIMIT 8`,
    [userId],
  );
  return rows.rows.map((row) => ({
    id: row.id as string,
    kind: row.kind as string,
    asset: row.asset as string,
    amount: row.amount as string,
    detail: (row.detail as string | null) ?? "",
    at: row.created_at as string,
  }));
}

async function paperActivity(pool: Db, userId: number) {
  const rows = await pool.query(
    `SELECT id::text, side, symbol, qty::text, notional_uusd::text, created_at
     FROM paper_trades WHERE user_id = $1 ORDER BY id DESC LIMIT 8`,
    [userId],
  );
  return rows.rows.map((row) => ({
    id: row.id as string,
    kind: "paper_fill",
    asset: row.symbol as string,
    amount: row.notional_uusd as string,
    detail: `${row.side as string} ${row.qty as string}`,
    at: row.created_at as string,
  }));
}

async function netUsdDeposits(pool: Db, userId: number): Promise<bigint> {
  const rows = await pool.query(
    `SELECT COALESCE(SUM(CASE
        WHEN kind = 'deposit_usd' THEN amount
        WHEN kind = 'withdraw_usd' THEN -amount
        ELSE 0 END), 0)::text AS n
     FROM activity WHERE user_id = $1 AND asset = 'USD'`,
    [userId],
  );
  return BigInt(rows.rows[0].n as string);
}

async function realHoldings(pool: Db, userId: number): Promise<Holding[]> {
  const rows = await pool.query(
    `SELECT a.asset,
            COALESCE(SUM(b.amount) FILTER (WHERE a.bucket = 'available'), 0)::text AS available,
            COALESCE(SUM(b.amount) FILTER (WHERE a.bucket = 'reserved'), 0)::text AS reserved
     FROM accounts a JOIN balances b ON b.account_id = a.id
     WHERE a.customer_id = $1 AND a.bucket IN ('available', 'reserved')
     GROUP BY a.asset`,
    [userId],
  );
  return rows.rows.map((row) => ({
    asset: row.asset as string,
    available: BigInt(row.available as string),
    reserved: BigInt(row.reserved as string),
  }));
}

async function paperHoldings(pool: Db, userId: number): Promise<Holding[]> {
  const rows = await pool.query(
    `SELECT asset, available::text, reserved::text FROM paper_balances WHERE user_id = $1`,
    [userId],
  );
  return rows.rows.map((row) => ({
    asset: row.asset as string,
    available: BigInt(row.available as string),
    reserved: BigInt(row.reserved as string),
  }));
}

function markUsd(asset: string, qty: bigint, stats: Map<string, DayStat>): bigint {
  if (qty === 0n) return 0n;
  if (asset === "USD") return qty;
  const inst = loadCatalog().find((row) => row.base === asset && row.quote === "USD");
  if (!inst) return 0n;
  const last = stats.get(inst.symbol)?.last;
  const px = last && last > 0 ? BigInt(Math.round(last)) : BigInt(inst.refPrice);
  return quoteNotional(qty, px, inst);
}

async function shapePaper(pool: Db, userId: number) {
  const stats = await loadDayStats(pool);
  const rows = await pool.query(
    `SELECT asset, available::text, reserved::text FROM paper_balances WHERE user_id = $1`,
    [userId],
  );
  const out: Record<string, { available: string; reserved: string }> = {
    USD: { available: "0", reserved: "0" },
    XAU: { available: "0", reserved: "0" },
  };
  for (const row of rows.rows) {
    out[row.asset as string] = { available: row.available as string, reserved: row.reserved as string };
  }
  const catalog = loadCatalog();
  const assets = Object.entries(out)
    .filter(([, slot]) => slot.available !== "0" || slot.reserved !== "0")
    .map(([asset, slot]) => {
      const inst = catalog.find((row) => row.base === asset && row.quote === "USD");
      const qty = BigInt(slot.available) + BigInt(slot.reserved);
      const usd = markUsd(asset, asset === "USD" ? BigInt(slot.available) : qty, stats).toString();
      return {
        asset,
        available: slot.available,
        reserved: slot.reserved,
        usd,
        qtyScale: inst?.qtyScale ?? (asset === "USD" ? 1_000_000 : 1000),
        qtyDecimals: inst?.qtyDecimals ?? (asset === "XAU" ? 3 : 4),
      };
    });
  return { entityId: null, jurisdiction: null, USD: out.USD, XAU: out.XAU, assets };
}

async function lockBal(client: { query: Db["query"] }, userId: number, asset: string): Promise<Holding> {
  let row = await client.query(
    `SELECT available::text, reserved::text FROM paper_balances WHERE user_id = $1 AND asset = $2 FOR UPDATE`,
    [userId, asset],
  );
  if (!row.rowCount) {
    await client.query(
      `INSERT INTO paper_balances (user_id, asset, available, reserved) VALUES ($1, $2, 0, 0)`,
      [userId, asset],
    );
    row = await client.query(
      `SELECT available::text, reserved::text FROM paper_balances WHERE user_id = $1 AND asset = $2 FOR UPDATE`,
      [userId, asset],
    );
  }
  return {
    asset,
    available: BigInt(row.rows[0].available as string),
    reserved: BigInt(row.rows[0].reserved as string),
  };
}

export async function chargePaperUsd(pool: Db, userId: number, amount: bigint): Promise<void> {
  if (amount <= 0n) return;
  await withTx(pool, async (client) => {
    const usd = await lockBal(client, userId, "USD");
    if (usd.available < amount) throw new PaperReject("INSUFFICIENT_FUNDS");
    usd.available -= amount;
    await client.query(
      `UPDATE paper_balances SET available = $3, reserved = $4 WHERE user_id = $1 AND asset = $2`,
      [userId, "USD", usd.available.toString(), usd.reserved.toString()],
    );
  });
}

export async function paperUsdAvailable(pool: Db, userId: number): Promise<bigint> {
  const row = await pool.query(
    `SELECT available::text FROM paper_balances WHERE user_id = $1 AND asset = 'USD'`,
    [userId],
  );
  return BigInt((row.rows[0]?.available as string | undefined) ?? "0");
}

export async function paperEnabled(pool: Db, userId: number): Promise<boolean> {
  const row = await pool.query(`SELECT enabled FROM paper_wallets WHERE user_id = $1`, [userId]);
  return Boolean(row.rows[0]?.enabled);
}

function top(levels: { price: number; qty: number }[]): { price: bigint; qty: bigint } | null {
  const lvl = levels[0];
  if (!lvl || lvl.price <= 0 || lvl.qty <= 0) return null;
  return { price: BigInt(Math.round(lvl.price)), qty: BigInt(Math.round(lvl.qty)) };
}
