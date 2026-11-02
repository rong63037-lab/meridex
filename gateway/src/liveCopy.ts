import type { Db } from "./db.js";
import type { EngineClient } from "./engineClient.js";
import { assertVerified, LiveError, pnlOf, productRow, spotOf, walletView } from "./liveCommon.js";
import { getInstrument } from "./instruments.js";
import { markOf } from "./liveCommon.js";
import { closeCopied, liveBoard } from "./liveTrade.js";

function num(value: string | number | null | undefined): bigint {
  return BigInt(value ?? "0");
}

export async function leaderStats(pool: Db, userId: number) {
  const rows = await pool.query(
    `SELECT realized_uusd::text, status, updated_at
     FROM real_positions
     WHERE user_id = $1 AND copy_follow_id IS NULL AND status <> 'open'
     ORDER BY updated_at, id`,
    [userId],
  );
  const curve: string[] = [];
  let cum = 0n;
  let peak = 0n;
  let drawdown = 0n;
  let wins = 0;
  for (const row of rows.rows) {
    const realized = num(row.realized_uusd as string);
    if (realized > 0n) wins += 1;
    cum += realized;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > drawdown) drawdown = dd;
    curve.push(cum.toString());
  }
  const open = await pool.query(
    `SELECT count(*)::int AS n FROM real_positions WHERE user_id = $1 AND copy_follow_id IS NULL AND status = 'open'`,
    [userId],
  );
  const followers = await pool.query(
    `SELECT count(*)::int AS n FROM real_copy_follows WHERE leader_id = $1 AND status <> 'stopped'`,
    [userId],
  );
  const closes = rows.rowCount ?? 0;
  return {
    closes,
    open: Number(open.rows[0]?.n ?? 0),
    followers: Number(followers.rows[0]?.n ?? 0),
    winRate: closes === 0 ? null : wins / closes,
    drawdownUusd: closes === 0 ? null : drawdown.toString(),
    realizedUusd: cum.toString(),
    curve,
  };
}

async function shapeLeader(pool: Db, userId: number, displayName: string, optedIn: boolean) {
  const user = await pool.query(`SELECT email, role, is_internal_test, address_pool_owner FROM users WHERE id = $1`, [userId]);
  const row = user.rows[0];
  if (!row || row.role !== "customer" || row.is_internal_test || row.address_pool_owner) return null;
  return {
    id: String(userId),
    displayName,
    optedIn,
    stats: await leaderStats(pool, userId),
  };
}

export async function listLeaders(pool: Db) {
  const rows = await pool.query(
    `SELECT l.user_id, l.display_name
     FROM real_copy_leaders l
     JOIN users u ON u.id = l.user_id
     WHERE l.opted_in = true AND u.role = 'customer' AND u.is_internal_test = false AND u.address_pool_owner = false
     ORDER BY l.created_at`,
  );
  const leaders = [];
  for (const row of rows.rows) leaders.push(await shapeLeader(pool, Number(row.user_id), row.display_name as string, true));
  return leaders.filter((item) => item != null);
}

export async function leaderProfile(pool: Db, userId: number) {
  const row = await pool.query(`SELECT display_name, opted_in FROM real_copy_leaders WHERE user_id = $1`, [userId]);
  if (!row.rowCount || !row.rows[0].opted_in) throw new LiveError("NOT_LEADER");
  const shaped = await shapeLeader(pool, userId, row.rows[0].display_name as string, true);
  if (!shaped) throw new LiveError("NOT_LEADER");
  const positions = await pool.query(
    `SELECT id::text, product, symbol, side, qty::text, entry_px::text, margin_uusd::text, leverage, status, realized_uusd::text, created_at
     FROM real_positions WHERE user_id = $1 AND copy_follow_id IS NULL ORDER BY id DESC LIMIT 20`,
    [userId],
  );
  return { ...shaped, positions: positions.rows };
}

export async function setLeader(pool: Db, userId: number, displayName: string, optedIn: boolean) {
  await assertVerified(pool, userId, "copy");
  const name = displayName.trim();
  if (optedIn && (name.length < 2 || name.length > 40 || /[\u0000-\u001f]/.test(name))) throw new LiveError("VALIDATION");
  if (optedIn) {
    await pool.query(
      `INSERT INTO real_copy_leaders (user_id, display_name, opted_in)
       VALUES ($1,$2,true)
       ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name, opted_in = true`,
      [userId, name],
    );
  } else {
    await pool.query(`UPDATE real_copy_leaders SET opted_in = false WHERE user_id = $1`, [userId]);
  }
  const mine = await pool.query(`SELECT display_name, opted_in FROM real_copy_leaders WHERE user_id = $1`, [userId]);
  return {
    displayName: (mine.rows[0]?.display_name as string | undefined) ?? "",
    optedIn: Boolean(mine.rows[0]?.opted_in),
    stats: await leaderStats(pool, userId),
  };
}

export async function followLeaderLive(
  pool: Db,
  userId: number,
  input: { leaderId: number; allocation: bigint; ratioBps: number; maxLoss: bigint },
) {
  await assertVerified(pool, userId, "copy");
  const spec = await productRow(pool, "copy");
  if (!spec.enabled) throw new LiveError("LIVE_OFF");
  if (input.leaderId === userId) throw new LiveError("COPY_SELF");
  if (input.allocation <= 0n || input.maxLoss <= 0n) throw new LiveError("VALIDATION");
  if (input.ratioBps < 1000 || input.ratioBps > 20000) throw new LiveError("VALIDATION");
  if (input.allocation > spec.maxNotional) throw new LiveError("CAP_NOTIONAL");
  const leader = await pool.query(
    `SELECT l.user_id FROM real_copy_leaders l
     JOIN users u ON u.id = l.user_id
     WHERE l.user_id = $1 AND l.opted_in = true AND u.role = 'customer' AND u.is_internal_test = false AND u.address_pool_owner = false`,
    [input.leaderId],
  );
  if (!leader.rowCount) throw new LiveError("NOT_LEADER");
  const used = await pool.query(
    `SELECT COALESCE(SUM(allocation_uusd),0)::text AS n
     FROM real_copy_follows WHERE status <> 'stopped'`,
  );
  const existing = await pool.query(
    `SELECT allocation_uusd::text, status FROM real_copy_follows WHERE follower_id = $1 AND leader_id = $2`,
    [userId, input.leaderId],
  );
  const prior = existing.rowCount && existing.rows[0].status !== "stopped" ? num(existing.rows[0].allocation_uusd as string) : 0n;
  if (num(used.rows[0].n as string) - prior + input.allocation > spec.maxNotional) throw new LiveError("CAP_NOTIONAL");
  await pool.query(
    `INSERT INTO real_copy_follows (follower_id, leader_id, allocation_uusd, ratio_bps, max_loss_uusd, status)
     VALUES ($1,$2,$3,$4,$5,'active')
     ON CONFLICT (follower_id, leader_id) DO UPDATE
       SET allocation_uusd = EXCLUDED.allocation_uusd, ratio_bps = EXCLUDED.ratio_bps,
           max_loss_uusd = EXCLUDED.max_loss_uusd, status = 'active'`,
    [userId, input.leaderId, input.allocation.toString(), input.ratioBps, input.maxLoss.toString()],
  );
  return copyBoard(pool, userId);
}

export async function setFollow(
  pool: Db,
  engine: EngineClient,
  userId: number,
  followId: string,
  action: "pause" | "resume" | "stop",
) {
  await assertVerified(pool, userId, "copy");
  const row = await pool.query(
    `SELECT id::text, status FROM real_copy_follows WHERE id = $1 AND follower_id = $2`,
    [followId, userId],
  );
  if (!row.rowCount) throw new LiveError("NOT_FOUND");
  if (action === "resume") {
    const spec = await productRow(pool, "copy");
    if (!spec.enabled) throw new LiveError("LIVE_OFF");
    await pool.query(`UPDATE real_copy_follows SET status = 'active' WHERE id = $1`, [followId]);
  } else if (action === "pause") {
    await pool.query(`UPDATE real_copy_follows SET status = 'paused' WHERE id = $1`, [followId]);
  } else {
    await pool.query(`UPDATE real_copy_follows SET status = 'stopped' WHERE id = $1`, [followId]);
    await closeCopied(pool, engine, userId, followId);
  }
  return copyBoard(pool, userId);
}

export async function copyBoard(pool: Db, userId: number) {
  const spec = await productRow(pool, "copy");
  let access = "allow";
  try {
    await assertVerified(pool, userId, "copy");
  } catch (err) {
    access = err instanceof Error ? err.message : "FORBIDDEN";
  }
  const leaders = access === "allow" ? await listLeaders(pool) : [];
  const follows = await pool.query(
    `SELECT f.id::text, f.leader_id::text, l.display_name, f.allocation_uusd::text, f.ratio_bps, f.max_loss_uusd::text, f.status
     FROM real_copy_follows f
     LEFT JOIN real_copy_leaders l ON l.user_id = f.leader_id
     WHERE f.follower_id = $1 AND f.status <> 'stopped'
     ORDER BY f.id DESC`,
    [userId],
  );
  const positions = await pool.query(
    `SELECT id::text, symbol, product, side, qty::text, entry_px::text, margin_uusd::text, leverage, realized_uusd::text,
            copy_follow_id::text, status, created_at
     FROM real_positions WHERE user_id = $1 AND copy_follow_id IS NOT NULL ORDER BY id DESC LIMIT 40`,
    [userId],
  );
  const open = positions.rows.filter((row) => row.status === "open");
  const mine = await pool.query(`SELECT display_name, opted_in FROM real_copy_leaders WHERE user_id = $1`, [userId]);
  const wallets = await walletView(pool, userId);
  const reduceOnly = !spec.enabled && (open.length > 0 || follows.rows.some((row) => row.status === "active" || row.status === "paused"));
  return {
    paper: false,
    live: spec.enabled && access === "allow",
    reduceOnly,
    access,
    maxNotionalUusd: spec.maxNotional.toString(),
    leaders,
    follows: follows.rows,
    positions: open,
    history: positions.rows.filter((row) => row.status !== "open"),
    wallets,
    me: mine.rowCount
      ? { displayName: mine.rows[0].display_name as string, optedIn: Boolean(mine.rows[0].opted_in), stats: await leaderStats(pool, userId) }
      : null,
  };
}

export async function copyBoardMarked(pool: Db, engine: EngineClient, userId: number) {
  const board = await copyBoard(pool, userId);
  const positions = [];
  for (const row of board.positions) {
    let upnl = 0n;
    try {
      const inst = getInstrument(spotOf(row.symbol as string));
      const px = await markOf(engine, spotOf(row.symbol as string));
      if (px.mark > 0n) upnl = pnlOf(inst, row.side as string, num(row.qty as string), num(row.entry_px as string), px.mark);
    } catch {
      upnl = 0n;
    }
    positions.push({ ...row, upnlUusd: upnl.toString(), mark: undefined });
  }
  const perp = await liveBoard(pool, engine, userId, "perp").catch(() => null);
  return { ...board, positions, markets: perp?.markets ?? [] };
}
