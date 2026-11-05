/** Withdrawal review. At or above withdraw.reviewUsd the funds are reserved until the owner decides. */
import { loadNumbers } from "./content.js";
import { withTx, type Db } from "./db.js";
import { PlatformError } from "./errors.js";
import { loadCatalog } from "./instruments.js";
import { holdFunds, LedgerError, releaseHold, settleHold, type CustomerRef } from "./ledger.js";
import { enqueueNotice, ingestSafe } from "./platform.js";
import { assertRealRails } from "./play.js";
import { requireFreshTotp } from "./pool.js";
import { loadCustomer } from "./trading.js";
import { formatScaled } from "./units.js";

export type WithdrawSource = "wallet" | "rail" | "crypto";

export type WithdrawInput = {
  userId: number;
  customer: CustomerRef;
  asset: string;
  network: string | null;
  address: string | null;
  gross: bigint;
  ledger: bigint;
  source: WithdrawSource;
};

function decimalsOf(asset: string): number {
  if (asset === "USD") return 6;
  if (asset === "XAU") return 3;
  const inst = loadCatalog().find((row) => row.base === asset && row.quote === "USD");
  return inst?.qtyDecimals ?? 8;
}

export function usdNotional(asset: string, gross: bigint): bigint | null {
  if (asset === "USD") return gross;
  const inst = loadCatalog().find((row) => row.base === asset && row.quote === "USD");
  if (!inst) return null;
  return (gross * BigInt(inst.refPrice) * BigInt(inst.quoteScale)) / (BigInt(inst.qtyScale) * BigInt(inst.priceScale));
}

export async function reviewThreshold(pool: Db): Promise<bigint> {
  const numbers = await loadNumbers(pool);
  const usd = numbers["withdraw.reviewUsd"] ?? 0;
  return BigInt(Math.round(usd * 1_000_000));
}

/** True when this withdrawal must wait. A missing price waits too. Threshold 0 waits for every positive amount. */
export async function reviewRequired(pool: Db, asset: string, gross: bigint): Promise<boolean> {
  const notional = usdNotional(asset, gross);
  if (notional == null) return true;
  const threshold = await reviewThreshold(pool);
  return notional >= threshold;
}

function fundsError(asset: string, err: unknown): never {
  if (err instanceof LedgerError && err.code === "INSUFFICIENT_BALANCE") {
    const code = asset === "USD" ? "INSUFFICIENT_FUNDS" : asset === "XAU" ? "INSUFFICIENT_GOLD" : "INSUFFICIENT_BALANCE";
    throw new PlatformError(code);
  }
  throw err;
}

async function audit(pool: Db, userId: number, kind: string, detail: string) {
  await pool.query(`INSERT INTO security_events (user_id, kind, detail) VALUES ($1,$2,$3)`, [userId, kind, detail.slice(0, 400)]);
}

function notice(pool: Db, userId: number, title: string, body: string) {
  return enqueueNotice(pool, userId, "inapp", title, body).catch((err) => {
    console.error("withdraw notice", err);
  });
}

export async function enqueueWithdrawal(pool: Db, input: WithdrawInput): Promise<{ id: number; status: "pending" }> {
  await assertRealRails(pool, input.userId);
  const notional = usdNotional(input.asset, input.gross) ?? input.ledger;
  const fee = input.ledger > input.gross ? input.ledger - input.gross : 0n;
  let id = 0;
  try {
    id = await withTx(pool, async (client) => {
      const holdId = await holdFunds(client, input.customer, input.asset, input.ledger, `wd:${input.source}:${input.userId}`);
      const row = await client.query(
        `INSERT INTO withdrawal_requests
           (user_id, asset, network, address, gross_amount, fee_amount, ledger_amount, notional_uusd, source, status, hold_transfer_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10)
         RETURNING id`,
        [
          input.userId,
          input.asset,
          input.network,
          input.address,
          input.gross.toString(),
          fee.toString(),
          input.ledger.toString(),
          notional.toString(),
          input.source,
          holdId,
        ],
      );
      return Number(row.rows[0].id);
    });
  } catch (err) {
    fundsError(input.asset, err);
  }
  await audit(pool, input.userId, "withdraw_pending", `${input.asset} ${input.ledger.toString()} id=${id} ${input.source}`);
  await notice(pool, input.userId, "出金待审核", "你的出金已冻结，等待工作人员审核。");
  void ingestSafe(pool, { userId: input.userId, kind: "withdraw", notionalUusd: notional });
  return { id, status: "pending" };
}

/** Small withdrawals that skip the queue. The caller still posts the ledger or the mock rail. */
export async function noteAutoWithdraw(pool: Db, input: WithdrawInput): Promise<void> {
  const notional = usdNotional(input.asset, input.gross) ?? input.ledger;
  await audit(pool, input.userId, "withdraw_auto", `${input.asset} ${input.ledger.toString()} ${input.source}`);
  await notice(pool, input.userId, "出金已处理", "这笔出金低于审核金额，已按原来的方式处理。");
  void ingestSafe(pool, { userId: input.userId, kind: "withdraw", notionalUusd: notional });
}

async function assertOwner(pool: Db, staffId: number) {
  const row = await pool.query(`SELECT address_pool_owner FROM users WHERE id = $1`, [staffId]);
  if (!row.rows[0]?.address_pool_owner) throw new PlatformError("FORBIDDEN", 403);
}

async function loadPending(pool: Db, id: number) {
  const row = await pool.query(
    `SELECT id, user_id, asset, ledger_amount::text, status FROM withdrawal_requests WHERE id = $1`,
    [id],
  );
  if (!row.rowCount) throw new PlatformError("NOT_FOUND", 404);
  return row.rows[0] as { id: string; user_id: string; asset: string; ledger_amount: string; status: string };
}

export async function approveWithdrawal(pool: Db, staffId: number, id: number, totp: string | undefined) {
  await assertOwner(pool, staffId);
  await requireFreshTotp(pool, staffId, totp);
  const existing = await loadPending(pool, id);
  if (existing.status !== "pending") throw new PlatformError("CONFLICT", 409);
  await assertRealRails(pool, Number(existing.user_id));
  const customer = await loadCustomer(pool, Number(existing.user_id));
  if (!customer) throw new PlatformError("KYC_REQUIRED", 403);
  const amount = BigInt(existing.ledger_amount);
  let transferId = "";
  try {
    transferId = await withTx(pool, async (client) => {
      const locked = await client.query(`SELECT status FROM withdrawal_requests WHERE id = $1 FOR UPDATE`, [id]);
      if (locked.rows[0]?.status !== "pending") throw new PlatformError("CONFLICT", 409);
      const settled = await settleHold(client, customer, existing.asset, amount, `wd-settle:${id}`, staffId);
      await client.query(
        `UPDATE withdrawal_requests
         SET status = 'approved', actor_id = $2, settle_transfer_id = $3, decided_at = now()
         WHERE id = $1`,
        [id, staffId, settled],
      );
      return settled;
    });
  } catch (err) {
    if (err instanceof PlatformError) throw err;
    fundsError(existing.asset, err);
  }
  await audit(pool, staffId, "withdraw_approve", `id=${id} user=${existing.user_id} ${existing.asset} ${amount.toString()} ${transferId}`);
  await notice(pool, Number(existing.user_id), "出金已通过", "你的出金已审核通过。");
  return { id, status: "approved" as const };
}

export async function rejectWithdrawal(
  pool: Db,
  staffId: number,
  id: number,
  totp: string | undefined,
  reason: string,
) {
  const text = reason.trim();
  if (text.length < 1 || text.length > 180) throw new PlatformError("VALIDATION");
  await assertOwner(pool, staffId);
  await requireFreshTotp(pool, staffId, totp);
  const existing = await loadPending(pool, id);
  if (existing.status !== "pending") throw new PlatformError("CONFLICT", 409);
  const customer = await loadCustomer(pool, Number(existing.user_id));
  if (!customer) throw new PlatformError("KYC_REQUIRED", 403);
  const amount = BigInt(existing.ledger_amount);
  try {
    await withTx(pool, async (client) => {
      const locked = await client.query(`SELECT status FROM withdrawal_requests WHERE id = $1 FOR UPDATE`, [id]);
      if (locked.rows[0]?.status !== "pending") throw new PlatformError("CONFLICT", 409);
      const released = await releaseHold(client, customer, existing.asset, amount, `wd-release:${id}`, staffId);
      await client.query(
        `UPDATE withdrawal_requests
         SET status = 'rejected', actor_id = $2, reason = $3, settle_transfer_id = $4, decided_at = now()
         WHERE id = $1`,
        [id, staffId, text, released],
      );
    });
  } catch (err) {
    if (err instanceof PlatformError) throw err;
    fundsError(existing.asset, err);
  }
  await audit(pool, staffId, "withdraw_reject", `id=${id} user=${existing.user_id} ${text}`);
  await notice(pool, Number(existing.user_id), "出金已退回", text);
  return { id, status: "rejected" as const };
}

export async function listWithdrawals(pool: Db, status: string, q = "") {
  const filter = status === "pending" || status === "approved" || status === "rejected" || status === "posted" ? status : "";
  const query = q.trim().slice(0, 120);
  const rows = await pool.query(
    `SELECT w.id, w.user_id, u.email, u.fund_id, u.display_name, u.is_internal_test,
            w.asset, w.network, w.address, w.gross_amount::text, w.fee_amount::text,
            w.ledger_amount::text, w.source, w.status, w.reason, w.tx_hash, w.created_at, w.decided_at, w.sent_at,
            a.email AS actor
     FROM withdrawal_requests w
     JOIN users u ON u.id = w.user_id
     LEFT JOIN users a ON a.id = w.actor_id
     WHERE ($1 = '' OR w.status = $1)
       AND ($2 = '' OR u.email ILIKE $3 OR u.fund_id ILIKE $3 OR coalesce(u.display_name, '') ILIKE $3
            OR w.asset ILIKE $3 OR coalesce(w.network, '') ILIKE $3 OR coalesce(w.address, '') ILIKE $3
            OR coalesce(w.tx_hash, '') ILIKE $3 OR w.id::text = $2 OR u.id::text = $2)
     ORDER BY w.created_at DESC
     LIMIT 80`,
    [filter, query, `%${query}%`],
  );
  return rows.rows.map((row) => {
    const decimals = decimalsOf(String(row.asset));
    const ledger = BigInt(row.ledger_amount as string);
    const fee = BigInt(row.fee_amount as string);
    return {
      id: Number(row.id),
      userId: Number(row.user_id),
      email: row.email as string,
      fundId: row.fund_id as string,
      name: (row.display_name as string | null) ?? "",
      internalTest: Boolean(row.is_internal_test),
      asset: row.asset as string,
      network: (row.network as string | null) ?? "",
      address: (row.address as string | null) ?? "",
      amount: formatScaled(ledger, decimals, decimals),
      fee: formatScaled(fee, decimals, decimals),
      source: row.source as string,
      status: row.status as string,
      reason: (row.reason as string | null) ?? "",
      txHash: (row.tx_hash as string | null) ?? "",
      actor: (row.actor as string | null) ?? "",
      createdAt: row.created_at,
      decidedAt: row.decided_at,
      sentAt: row.sent_at,
    };
  });
}

/** Operational mark after approve. The hold was already settled. This only records the chain hash. */
export async function markWithdrawalSent(pool: Db, staffId: number, id: number, totp: string | undefined, txHash: string) {
  const tx = txHash.trim();
  if (tx.length < 4 || tx.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(tx)) throw new PlatformError("VALIDATION");
  await assertOwner(pool, staffId);
  await requireFreshTotp(pool, staffId, totp);
  const existing = await loadPending(pool, id);
  if (existing.status !== "approved") throw new PlatformError("CONFLICT", 409);
  const updated = await pool.query(
    `UPDATE withdrawal_requests
     SET status = 'posted', tx_hash = $2, sent_at = now(), sent_actor_id = $3
     WHERE id = $1 AND status = 'approved'
     RETURNING id`,
    [id, tx, staffId],
  );
  if (!updated.rowCount) throw new PlatformError("CONFLICT", 409);
  await audit(pool, staffId, "withdraw_sent", `id=${id} user=${existing.user_id} tx=${tx}`);
  return { id, status: "posted" as const, txHash: tx };
}
