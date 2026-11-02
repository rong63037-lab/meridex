/** Play-money sandbox for internal test accounts. Never writes the ledger, the trades tape, or the matching engine. */
import type { Db } from "./db.js";
import { withTx } from "./db.js";
import type { EngineClient } from "./engineClient.js";
import { generateTotpSecret, hashPassword } from "./crypto.js";
import { loadNumbers } from "./content.js";
import { PlatformError, assertPassword } from "./platform.js";
import { LedgerError } from "./ledger.js";
import { getInstrument, loadCatalog, quoteNotional, type Instrument } from "./instruments.js";
import type { OrderResponse } from "./trading.js";

type Holding = { available: bigint; reserved: bigint };

export type PlayOrderInput = {
  side: "buy" | "sell";
  orderType: string;
  priceCents: bigint | null;
  stopPriceCents: bigint | null;
  qty: bigint;
  symbol: string;
};

export async function isInternalTest(pool: Db, userId: number): Promise<boolean> {
  const row = await pool.query(`SELECT is_internal_test FROM users WHERE id = $1`, [userId]);
  return Boolean(row.rows[0]?.is_internal_test);
}

export async function assertRealRails(pool: Db, userId: number): Promise<void> {
  if (await isInternalTest(pool, userId)) throw new PlatformError("PLAY_ONLY", 403);
}

export async function listInternal(pool: Db) {
  const rows = await pool.query(
    `SELECT u.id, u.email, u.display_name, u.disabled, u.totp_enabled, u.created_at,
            COALESCE(b.available, 0)::text AS usd_available
     FROM users u
     LEFT JOIN play_balances b ON b.user_id = u.id AND b.asset = 'USD'
     WHERE u.is_internal_test
     ORDER BY u.id DESC`,
  );
  return rows.rows.map((row) => ({
    id: Number(row.id),
    email: row.email as string,
    name: (row.display_name as string | null) ?? "",
    disabled: Boolean(row.disabled),
    totpEnabled: Boolean(row.totp_enabled),
    usdAvailable: row.usd_available as string,
    createdAt: row.created_at,
    badge: "INTERNAL TEST / 内部测试",
  }));
}

export async function createInternal(
  pool: Db,
  actorId: number,
  input: { email: string; name: string; password: string; totp: boolean },
) {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim().slice(0, 80);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name) throw new PlatformError("VALIDATION");
  await assertPassword(pool, input.password);
  const secret = generateTotpSecret();
  const inserted = await pool.query(
    `INSERT INTO users (email, password_hash, totp_secret, role, entity_id, jurisdiction, kyc_tier, is_internal_test, display_name, totp_enabled)
     VALUES ($1,$2,$3,'customer','SG-OPCO','SG','staff',true,$4,$5)
     ON CONFLICT (email) DO NOTHING
     RETURNING id`,
    [email, hashPassword(input.password), secret, name, input.totp],
  );
  if (!inserted.rowCount) throw new PlatformError("EMAIL_TAKEN", 409);
  const id = Number(inserted.rows[0].id);
  await pool.query(
    `INSERT INTO kyc_profiles (user_id, nationality, residence_country, sanctions_hit, status, reason, entity_id)
     VALUES ($1,'SG','SG',false,'approved','INTERNAL_TEST','SG-OPCO')
     ON CONFLICT (user_id) DO NOTHING`,
    [id],
  );
  await pool.query(
    `INSERT INTO security_events (user_id, kind, detail) VALUES ($1,'internal_create',$2)`,
    [actorId, JSON.stringify({ id, email, totp: input.totp })],
  );
  return { id, email, name, totpEnabled: input.totp, totpSecret: input.totp ? secret : null, badge: "INTERNAL TEST / 内部测试" };
}

export async function setInternalPassword(pool: Db, actorId: number, userId: number, password: string) {
  await requireInternal(pool, userId);
  await assertPassword(pool, password);
  await pool.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [userId, hashPassword(password)]);
  await pool.query(`INSERT INTO security_events (user_id, kind, detail) VALUES ($1,'internal_password',$2)`, [
    actorId,
    JSON.stringify({ id: userId }),
  ]);
  return { id: userId, reset: true };
}

export async function setInternalDisabled(pool: Db, actorId: number, userId: number, disabled: boolean) {
  await requireInternal(pool, userId);
  await pool.query(`UPDATE users SET disabled = $2 WHERE id = $1`, [userId, disabled]);
  await pool.query(`INSERT INTO security_events (user_id, kind, detail) VALUES ($1,'internal_disabled',$2)`, [
    actorId,
    JSON.stringify({ id: userId, disabled }),
  ]);
  return { id: userId, disabled };
}

export async function deleteInternal(pool: Db, actorId: number, userId: number) {
  await requireInternal(pool, userId);
  await pool.query(`DELETE FROM play_trades WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM play_orders WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM play_balances WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM play_moves WHERE user_id = $1`, [userId]);
  const fks = await pool.query(
    `SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
     FROM pg_constraint c
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.confrelid = 'users'::regclass AND c.contype = 'f' AND c.conrelid <> 'users'::regclass`,
  );
  for (const row of fks.rows) {
    const tbl = String(row.tbl).replaceAll('"', "");
    const col = String(row.col);
    if (!/^[a-z_]+$/.test(tbl) || !/^[a-z_]+$/.test(col)) continue;
    await pool.query(`DELETE FROM ${tbl} WHERE ${col} = $1`, [userId]);
  }
  await pool.query(`UPDATE users SET account_manager_id = NULL WHERE account_manager_id = $1`, [userId]);
  const gone = await pool.query(`DELETE FROM users WHERE id = $1 AND is_internal_test RETURNING email`, [userId]);
  if (!gone.rowCount) throw new PlatformError("NOT_FOUND", 404);
  await pool.query(`INSERT INTO security_events (user_id, kind, detail) VALUES ($1,'internal_delete',$2)`, [
    actorId,
    JSON.stringify({ id: userId, email: gone.rows[0].email }),
  ]);
  return { id: userId, deleted: true };
}

export async function movePlay(
  pool: Db,
  actorId: number,
  userId: number,
  input: { direction: "credit" | "debit"; asset: string; amount: bigint; reason: string },
) {
  await requireInternal(pool, userId);
  const asset = input.asset.toUpperCase();
  const known = asset === "USD" || loadCatalog().some((row) => row.base === asset);
  const reason = input.reason.trim().slice(0, 180);
  if (!known || input.amount <= 0n || reason.length < 3) throw new PlatformError("VALIDATION");
  return withTx(pool, async (client) => {
    const row = await lockPlay(client, userId, asset);
    const before = row.available;
    if (input.direction === "credit") row.available += input.amount;
    else if (row.available < input.amount) throw new PlatformError("INSUFFICIENT_FUNDS");
    else row.available -= input.amount;
    await client.query(`UPDATE play_balances SET available = $3, reserved = $4 WHERE user_id = $1 AND asset = $2`, [
      userId,
      asset,
      row.available.toString(),
      row.reserved.toString(),
    ]);
    await client.query(
      `INSERT INTO play_moves (user_id, actor_id, asset, direction, amount, reason) VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId, actorId, asset, input.direction, input.amount.toString(), reason],
    );
    await client.query(`INSERT INTO security_events (user_id, kind, detail) VALUES ($1,$2,$3)`, [
      actorId,
      input.direction === "credit" ? "play_credit" : "play_debit",
      JSON.stringify({
        id: userId,
        asset,
        direction: input.direction,
        amount: input.amount.toString(),
        old: before.toString(),
        new: row.available.toString(),
        reason,
      }),
    ]);
    return { userId, asset, direction: input.direction, available: row.available.toString(), reason };
  });
}

export async function internalDetail(pool: Db, userId: number) {
  await requireInternal(pool, userId);
  const user = await pool.query(
    `SELECT id, email, display_name, disabled, totp_enabled, created_at FROM users WHERE id = $1`,
    [userId],
  );
  const balances = await pool.query(
    `SELECT asset, available::text, reserved::text FROM play_balances WHERE user_id = $1 ORDER BY asset`,
    [userId],
  );
  const trades = await pool.query(
    `SELECT id, symbol, side, price_px::text, qty::text, notional_uusd::text, fee_uusd::text, liquidity, created_at
     FROM play_trades WHERE user_id = $1 ORDER BY created_at DESC LIMIT 40`,
    [userId],
  );
  const moves = await pool.query(
    `SELECT id, asset, direction, amount::text, reason, created_at FROM play_moves WHERE user_id = $1 ORDER BY id DESC LIMIT 40`,
    [userId],
  );
  return {
    user: { ...user.rows[0], badge: "INTERNAL TEST / 内部测试" },
    balances: balances.rows,
    trades: trades.rows,
    moves: moves.rows,
  };
}

export async function internalSummary(pool: Db) {
  const accounts = await pool.query(`SELECT count(*)::int AS n FROM users WHERE is_internal_test AND disabled = false`);
  const volume = await pool.query(`SELECT COALESCE(SUM(notional_uusd),0)::text AS n, count(*)::int AS trades FROM play_trades`);
  const fees = await pool.query(`SELECT COALESCE(SUM(fee_uusd),0)::text AS n FROM play_trades`);
  const cash = await pool.query(
    `SELECT COALESCE(SUM(available + reserved),0)::text AS n FROM play_balances WHERE asset = 'USD'`,
  );
  return {
    badge: "INTERNAL TEST / 内部测试",
    accounts: accounts.rows[0].n as number,
    trades: volume.rows[0].trades as number,
    volumeUusd: volume.rows[0].n as string,
    feeUusd: fees.rows[0].n as string,
    playUsd: cash.rows[0].n as string,
  };
}

export async function playBalances(pool: Db, userId: number) {
  const user = await pool.query(`SELECT entity_id, jurisdiction FROM users WHERE id = $1`, [userId]);
  const rows = await pool.query(`SELECT asset, available::text, reserved::text FROM play_balances WHERE user_id = $1`, [userId]);
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
      let usd = "0";
      if (asset === "USD") usd = (BigInt(slot.available) + BigInt(slot.reserved)).toString();
      else if (inst) {
        const qty = BigInt(slot.available) + BigInt(slot.reserved);
        usd = ((qty * BigInt(inst.refPrice) * BigInt(inst.quoteScale)) / (BigInt(inst.qtyScale) * BigInt(inst.priceScale))).toString();
      }
      return {
        asset,
        available: slot.available,
        reserved: slot.reserved,
        usd,
        qtyScale: inst?.qtyScale ?? (asset === "USD" ? 1_000_000 : 1000),
        qtyDecimals: inst?.qtyDecimals ?? (asset === "XAU" ? 3 : 4),
        play: true,
      };
    });
  return {
    entityId: user.rows[0]?.entity_id ?? null,
    jurisdiction: user.rows[0]?.jurisdiction ?? null,
    play: true,
    USD: out.USD,
    XAU: out.XAU,
    assets,
  };
}

export async function listPlayOrders(pool: Db, userId: number) {
  const rows = await pool.query(
    `SELECT id AS engine_order_id, symbol, side, order_type, price_px::text AS price_cents, stop_px::text AS stop_price_cents,
            NULL::text AS stop_limit_cents, NULL::text AS group_id, qty::text AS qty_mg, leaves::text AS leaves_mg,
            filled::text AS filled_mg, '0' AS filled_notional_uusd, status, NULL::text AS reject_reason, created_at
     FROM play_orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 80`,
    [userId],
  );
  return rows.rows;
}

export async function listPlayTrades(pool: Db, userId: number) {
  const rows = await pool.query(
    `SELECT id AS engine_trade_id, symbol, price_px::text AS price_cents, qty::text AS qty_mg, notional_uusd::text,
            fee_uusd::text, side AS "userSide", liquidity, created_at AS tape_at
     FROM play_trades WHERE user_id = $1 ORDER BY created_at DESC LIMIT 80`,
    [userId],
  );
  return rows.rows;
}

export async function placePlayOrder(pool: Db, engine: EngineClient, userId: number, input: PlayOrderInput): Promise<OrderResponse> {
  if (!(await isInternalTest(pool, userId))) throw new LedgerError("FORBIDDEN");
  let inst: Instrument;
  try {
    inst = getInstrument(input.symbol);
  } catch {
    throw new LedgerError("UNKNOWN_SYMBOL");
  }
  if (inst.status !== "trading") throw new LedgerError("MARKET_HALTED");
  if (input.qty <= 0n || input.qty < BigInt(inst.minQty)) throw new LedgerError("VALIDATION");
  const health = await engine.health(inst.symbol);
  if (health.halted) throw new LedgerError("MARKET_HALTED");
  const ref = align(BigInt(Math.round(health.reference_price)), BigInt(inst.tickSize));
  if (ref <= 0n) throw new LedgerError("EMPTY_BOOK");
  const numbers = await loadNumbers(pool);
  const takerBps = numbers["fee.standard.takerBps"];
  const makerBps = numbers["fee.standard.makerBps"];
  const needsLimit = input.orderType !== "market";
  if (needsLimit && (input.priceCents == null || input.priceCents <= 0n)) throw new LedgerError("VALIDATION");
  if (needsLimit && input.priceCents != null && input.priceCents % BigInt(inst.tickSize) !== 0n) throw new LedgerError("TICK");
  if (input.priceCents != null && (input.priceCents < BigInt(health.band_low) || input.priceCents > BigInt(health.band_high))) {
    return rejected("PRICE_BAND");
  }
  const limit = input.priceCents ?? ref;
  const crosses = input.orderType === "market" || (input.side === "buy" ? limit >= ref : limit <= ref);
  if (input.orderType === "post_only" && crosses) return rejected("POST_ONLY");
  if (input.orderType === "fok" && !crosses) return rejected("FOK_UNFILLABLE");
  if ((input.orderType === "market" || input.orderType === "ioc") && !crosses) return rejected("EMPTY_BOOK");
  const stop = input.orderType === "stop_limit" || input.orderType === "oco" ? input.stopPriceCents : null;
  if ((input.orderType === "stop_limit" || input.orderType === "oco") && stop == null) throw new LedgerError("VALIDATION");
  if ((input.orderType === "stop_limit" || input.orderType === "oco") && stop != null && stop % BigInt(inst.tickSize) !== 0n) throw new LedgerError("TICK");
  const armed = input.orderType === "stop_limit" && stop != null && !triggered(input.side, stop, ref);
  const fillNow = !armed && crosses && input.orderType !== "post_only";
  const rest = !fillNow && input.orderType !== "market" && input.orderType !== "ioc" && input.orderType !== "fok";
  if (!fillNow && !rest) return rejected("EMPTY_BOOK");

  const orderId = crypto.randomUUID();
  const feeBpsNow = takerBps;
  try {
    const trade = await withTx(pool, async (client) => {
      const quote = await lockPlay(client, userId, inst.quote);
      const base = await lockPlay(client, userId, inst.base);
      let fee = 0n;
      if (fillNow) {
        fee = await takeFill(client, userId, inst, input.side, input.qty, ref, feeBpsNow, quote, base);
      } else {
        await reserveRest(inst, input.side, input.qty, limit, Math.max(makerBps, takerBps), quote, base);
        await writeHolding(client, userId, inst.quote, quote);
        await writeHolding(client, userId, inst.base, base);
      }
      const status = fillNow ? "filled" : armed ? "armed" : "open";
      await client.query(
        `INSERT INTO play_orders (id, user_id, symbol, side, order_type, price_px, stop_px, qty, leaves, filled, status, fee_uusd)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          orderId,
          userId,
          inst.symbol,
          input.side,
          input.orderType,
          limit.toString(),
          stop?.toString() ?? null,
          input.qty.toString(),
          fillNow ? "0" : input.qty.toString(),
          fillNow ? input.qty.toString() : "0",
          status,
          fee.toString(),
        ],
      );
      let tradeId: string | null = null;
      if (fillNow) {
        tradeId = crypto.randomUUID();
        const notional = quoteNotional(input.qty, ref, inst);
        await client.query(
          `INSERT INTO play_trades (id, user_id, order_id, symbol, side, price_px, qty, notional_uusd, fee_uusd, liquidity)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'taker')`,
          [tradeId, userId, orderId, inst.symbol, input.side, ref.toString(), input.qty.toString(), notional.toString(), fee.toString()],
        );
      }
      return { fee, tradeId, status };
    });
    return {
      orderId,
      status: trade.status,
      rejectReason: null,
      filledMg: fillNow ? input.qty.toString() : "0",
      leavesMg: fillNow ? "0" : input.qty.toString(),
      trades: trade.tradeId ? [{ price: Number(ref), qty: Number(input.qty), tradeId: trade.tradeId }] : [],
    };
  } catch (err) {
    if (err instanceof PlatformError && err.code === "INSUFFICIENT_FUNDS") throw new LedgerError("INSUFFICIENT_FUNDS");
    throw err;
  }
}

export async function cancelAllPlay(pool: Db, userId: number) {
  const open = await pool.query(
    `SELECT id FROM play_orders WHERE user_id = $1 AND status IN ('open', 'armed')`,
    [userId],
  );
  const canceled: string[] = [];
  for (const row of open.rows) {
    try {
      await cancelPlayOrder(pool, userId, row.id as string);
      canceled.push(row.id as string);
    } catch {
      /* a fill can win the race */
    }
  }
  return { canceled };
}

export async function cancelPlayOrder(pool: Db, userId: number, orderId: string) {
  if (!(await isInternalTest(pool, userId))) throw new LedgerError("FORBIDDEN");
  return withTx(pool, async (client) => {
    const row = await client.query(
      `SELECT symbol, side, price_px::text, qty::text, leaves::text, status FROM play_orders WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [orderId, userId],
    );
    if (!row.rowCount || (row.rows[0].status !== "open" && row.rows[0].status !== "armed")) throw new LedgerError("NOT_FOUND");
    const inst = getInstrument(row.rows[0].symbol as string);
    const leaves = BigInt(row.rows[0].leaves);
    const price = BigInt(row.rows[0].price_px);
    const numbers = await loadNumbers(pool);
    const feeBps = Math.max(numbers["fee.standard.makerBps"], numbers["fee.standard.takerBps"]);
    if (row.rows[0].side === "buy") {
      const quote = await lockPlay(client, userId, inst.quote);
      const release = quoteNotional(leaves, price, inst) + (quoteNotional(leaves, price, inst) * BigInt(feeBps)) / 10_000n;
      const give = release < quote.reserved ? release : quote.reserved;
      quote.reserved -= give;
      quote.available += give;
      await writeHolding(client, userId, inst.quote, quote);
    } else {
      const base = await lockPlay(client, userId, inst.base);
      const give = leaves < base.reserved ? leaves : base.reserved;
      base.reserved -= give;
      base.available += give;
      await writeHolding(client, userId, inst.base, base);
    }
    await client.query(`UPDATE play_orders SET status = 'canceled', leaves = 0 WHERE id = $1`, [orderId]);
    return { orderId, status: "canceled", rejectReason: null, filledMg: "0", leavesMg: "0", trades: [] };
  });
}

/** Fill resting play orders when the live reference has traded through them. Does not send engine commands. */
export async function sweepPlay(pool: Db, engine: EngineClient): Promise<number[]> {
  const open = await pool.query(
    `SELECT id, user_id, symbol, side, order_type, price_px::text, stop_px::text, leaves::text, status
     FROM play_orders WHERE status IN ('open', 'armed') ORDER BY created_at LIMIT 40`,
  );
  const touched: number[] = [];
  const numbers = open.rowCount ? await loadNumbers(pool) : null;
  for (const row of open.rows) {
    let inst: Instrument;
    try {
      inst = getInstrument(row.symbol as string);
    } catch {
      continue;
    }
    const health = await engine.health(inst.symbol);
    if (health.halted) continue;
    const ref = align(BigInt(Math.round(health.reference_price)), BigInt(inst.tickSize));
    const side = row.side as "buy" | "sell";
    const limit = BigInt(row.price_px);
    const stop = row.stop_px == null ? null : BigInt(row.stop_px);
    if (row.status === "armed") {
      if (stop == null || !triggered(side, stop, ref)) continue;
    }
    const crosses = side === "buy" ? ref <= limit : ref >= limit;
    if (!crosses) continue;
    const leaves = BigInt(row.leaves);
    const maker = numbers ? numbers["fee.standard.makerBps"] : 0;
    const userId = Number(row.user_id);
    try {
      const filled = await withTx(pool, async (client) => {
        const locked = await client.query(`SELECT status, leaves::text FROM play_orders WHERE id = $1 FOR UPDATE`, [row.id]);
        if (!locked.rowCount || (locked.rows[0].status !== "open" && locked.rows[0].status !== "armed")) return false;
        const qty = BigInt(locked.rows[0].leaves);
        if (qty <= 0n) return false;
        const quote = await lockPlay(client, userId, inst.quote);
        const base = await lockPlay(client, userId, inst.base);
        const notional = quoteNotional(qty, ref, inst);
        const fee = (notional * BigInt(maker)) / 10_000n;
        if (side === "buy") {
          const held = quoteNotional(qty, limit, inst) + (quoteNotional(qty, limit, inst) * BigInt(Math.max(maker, numbers?.["fee.standard.takerBps"] ?? maker))) / 10_000n;
          const reserved = held < quote.reserved ? held : quote.reserved;
          const need = notional + fee;
          if (reserved + quote.available < need) return false;
          const fromReserved = need < reserved ? need : reserved;
          quote.reserved -= reserved;
          quote.available += reserved - fromReserved;
          quote.available -= need - fromReserved;
          base.available += qty;
        } else {
          const reserved = qty < base.reserved ? qty : base.reserved;
          if (reserved < qty) return false;
          if (notional <= fee) return false;
          base.reserved -= qty;
          quote.available += notional - fee;
        }
        await writeHolding(client, userId, inst.quote, quote);
        await writeHolding(client, userId, inst.base, base);
        const tradeId = crypto.randomUUID();
        await client.query(
          `INSERT INTO play_trades (id, user_id, order_id, symbol, side, price_px, qty, notional_uusd, fee_uusd, liquidity)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'maker')`,
          [tradeId, userId, row.id, inst.symbol, side, ref.toString(), qty.toString(), notional.toString(), fee.toString()],
        );
        await client.query(
          `UPDATE play_orders SET status = 'filled', leaves = 0, filled = play_orders.filled + $2, fee_uusd = play_orders.fee_uusd + $3 WHERE id = $1`,
          [row.id, qty.toString(), fee.toString()],
        );
        return true;
      });
      if (filled) touched.push(userId);
    } catch {
      /* leave the order resting when the play balance cannot pay the fee */
    }
    void leaves;
  }
  return touched;
}

async function requireInternal(pool: Db, userId: number) {
  const row = await pool.query(`SELECT is_internal_test FROM users WHERE id = $1`, [userId]);
  if (!row.rowCount || !row.rows[0].is_internal_test) throw new PlatformError("NOT_FOUND", 404);
}

async function lockPlay(client: { query: Db["query"] }, userId: number, asset: string): Promise<Holding> {
  await client.query(
    `INSERT INTO play_balances (user_id, asset, available, reserved) VALUES ($1,$2,0,0) ON CONFLICT DO NOTHING`,
    [userId, asset],
  );
  const row = await client.query(`SELECT available::text, reserved::text FROM play_balances WHERE user_id = $1 AND asset = $2 FOR UPDATE`, [
    userId,
    asset,
  ]);
  return { available: BigInt(row.rows[0].available), reserved: BigInt(row.rows[0].reserved) };
}

async function writeHolding(client: { query: Db["query"] }, userId: number, asset: string, row: Holding) {
  await client.query(`UPDATE play_balances SET available = $3, reserved = $4 WHERE user_id = $1 AND asset = $2`, [
    userId,
    asset,
    row.available.toString(),
    row.reserved.toString(),
  ]);
}

async function takeFill(
  client: { query: Db["query"] },
  userId: number,
  inst: Instrument,
  side: "buy" | "sell",
  qty: bigint,
  ref: bigint,
  feeBps: number,
  quote: Holding,
  base: Holding,
) {
  const notional = quoteNotional(qty, ref, inst);
  const fee = (notional * BigInt(feeBps)) / 10_000n;
  if (side === "buy") {
    if (quote.available < notional + fee) throw new PlatformError("INSUFFICIENT_FUNDS");
    quote.available -= notional + fee;
    base.available += qty;
  } else {
    if (base.available < qty) throw new PlatformError("INSUFFICIENT_FUNDS");
    if (notional <= fee) throw new PlatformError("INSUFFICIENT_FUNDS");
    base.available -= qty;
    quote.available += notional - fee;
  }
  await writeHolding(client, userId, inst.quote, quote);
  await writeHolding(client, userId, inst.base, base);
  return fee;
}

async function reserveRest(inst: Instrument, side: "buy" | "sell", qty: bigint, limit: bigint, feeBps: number, quote: Holding, base: Holding) {
  if (side === "buy") {
    const notional = quoteNotional(qty, limit, inst);
    const fee = (notional * BigInt(feeBps)) / 10_000n;
    if (quote.available < notional + fee) throw new PlatformError("INSUFFICIENT_FUNDS");
    quote.available -= notional + fee;
    quote.reserved += notional + fee;
  } else if (base.available < qty) {
    throw new PlatformError("INSUFFICIENT_FUNDS");
  } else {
    base.available -= qty;
    base.reserved += qty;
  }
}

function align(price: bigint, tick: bigint): bigint {
  if (tick <= 1n) return price;
  return price - (price % tick);
}

function triggered(side: "buy" | "sell", stop: bigint, ref: bigint): boolean {
  return side === "buy" ? ref >= stop : ref <= stop;
}

function rejected(reason: string): OrderResponse {
  return { orderId: "", status: "rejected", rejectReason: reason, filledMg: "0", leavesMg: "0", trades: [] };
}
