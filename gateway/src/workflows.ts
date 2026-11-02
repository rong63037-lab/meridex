import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.js";
import { withTx } from "./db.js";
import { deposit, LedgerError, withdraw, type CustomerRef } from "./ledger.js";
import { loadCustomer } from "./trading.js";
import { onDepositCredited, recordDeposit } from "./concierge.js";
import { redemptionFees } from "./content.js";

export const REDEMPTION_PRODUCTS = [
  { id: "coin_1oz", grams: 31.103, feeUsd: 15, deliveryFeeUsd: 40 },
  { id: "bar_100g", grams: 100, feeUsd: 25, deliveryFeeUsd: 40 },
  { id: "bar_1000g", grams: 1000, feeUsd: 80, deliveryFeeUsd: 60 },
] as const;

const stepMs = () => Number(process.env.WORKFLOW_STEP_MS ?? 1200);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function recordLogin(
  pool: Db,
  userId: number,
  meta: { ip: string | null; country: string | null; userAgent: string | null },
): Promise<string> {
  const id = crypto.randomUUID();
  const label = !meta.userAgent
    ? "unknown"
    : /iPhone|iPad/i.test(meta.userAgent)
      ? "iOS"
      : /Android/i.test(meta.userAgent)
        ? "Android"
        : /Mac OS/i.test(meta.userAgent)
          ? "Mac"
          : /Windows/i.test(meta.userAgent)
            ? "Windows"
            : /Linux/i.test(meta.userAgent)
              ? "Linux"
              : "browser";
  await pool.query(
    `INSERT INTO sessions (id, user_id, ip, country, user_agent, device_label) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, userId, meta.ip, meta.country, meta.userAgent, label],
  );
  await pool.query(
    `INSERT INTO login_events (user_id, ip, country, user_agent) VALUES ($1,$2,$3,$4)`,
    [userId, meta.ip, meta.country, meta.userAgent],
  );
  return id;
}

export async function touchSession(pool: Db, id: string): Promise<boolean> {
  const row = await pool.query(`SELECT revoked FROM sessions WHERE id = $1`, [id]);
  if (!row.rowCount || row.rows[0].revoked) return false;
  await pool.query(`UPDATE sessions SET last_seen = now() WHERE id = $1`, [id]);
  return true;
}

export async function listSessions(pool: Db, userId: number) {
  const rows = await pool.query(
    `SELECT id, ip, country, user_agent, device_label, revoked, created_at, last_seen
     FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [userId],
  );
  return rows.rows;
}

export async function revokeSession(pool: Db, userId: number, id: string): Promise<boolean> {
  const row = await pool.query(
    `UPDATE sessions SET revoked = true WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, userId],
  );
  return Boolean(row.rowCount);
}

export async function listLogins(pool: Db, userId: number) {
  const rows = await pool.query(
    `SELECT id, ip, country, user_agent, created_at FROM login_events
     WHERE user_id = $1 ORDER BY id DESC LIMIT 30`,
    [userId],
  );
  return rows.rows;
}

export async function createApiKey(
  pool: Db,
  userId: number,
  label: string,
  opts?: { scopes?: string; ipWhitelist?: string },
): Promise<{ id: string; token: string; secret: string; prefix: string; scopes: string }> {
  const requested = (opts?.scopes ?? "read").split(",").map((item) => item.trim()).filter((item) => item === "read" || item === "trade");
  const scopes = requested.length ? [...new Set(requested)].join(",") : "read";
  const secret = randomBytes(24).toString("base64url");
  const id = crypto.randomUUID();
  const prefix = id.slice(0, 8);
  await pool.query(
    `INSERT INTO api_keys (id, user_id, label, prefix, secret_hash, scopes, ip_whitelist, secret_sandbox)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, userId, label.slice(0, 40), prefix, sha256(secret), scopes, opts?.ipWhitelist?.slice(0, 200) ?? null, secret],
  );
  return { id, token: secret, secret, prefix, scopes };
}

export async function listApiKeys(pool: Db, userId: number) {
  const rows = await pool.query(
    `SELECT id, label, prefix, scopes, ip_whitelist, revoked, created_at FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return rows.rows;
}

export async function revokeApiKey(pool: Db, userId: number, id: string): Promise<boolean> {
  const row = await pool.query(`UPDATE api_keys SET revoked = true WHERE id = $1 AND user_id = $2 RETURNING id`, [id, userId]);
  return Boolean(row.rowCount);
}

export async function getPrefs(pool: Db, userId: number) {
  const rows = await pool.query(`SELECT fills, rejects, announcements FROM notification_prefs WHERE user_id = $1`, [userId]);
  if (!rows.rowCount) return { fills: true, rejects: true, announcements: true };
  return rows.rows[0];
}

export async function savePrefs(
  pool: Db,
  userId: number,
  prefs: { fills: boolean; rejects: boolean; announcements: boolean },
) {
  await pool.query(
    `INSERT INTO notification_prefs (user_id, fills, rejects, announcements)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id) DO UPDATE SET fills = EXCLUDED.fills, rejects = EXCLUDED.rejects,
       announcements = EXCLUDED.announcements, updated_at = now()`,
    [userId, prefs.fills, prefs.rejects, prefs.announcements],
  );
  return prefs;
}

export async function createRail(pool: Db, userId: number, direction: "deposit" | "withdraw", amountUusd: bigint) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO rail_transfers (id, user_id, direction, amount_uusd, status, detail)
     VALUES ($1,$2,$3,$4,'submitted','模拟银行通道已受理')`,
    [id, userId, direction, amountUusd.toString()],
  );
  return railById(pool, userId, id);
}

export async function listRails(pool: Db, userId: number) {
  const rows = await pool.query(
    `SELECT id, direction, amount_uusd::text, status, detail, created_at, updated_at
     FROM rail_transfers WHERE user_id = $1 ORDER BY created_at DESC LIMIT 40`,
    [userId],
  );
  return rows.rows;
}

async function railById(pool: Db, userId: number, id: string) {
  const rows = await pool.query(
    `SELECT id, direction, amount_uusd::text, status, detail, created_at, updated_at
     FROM rail_transfers WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows.rows[0];
}

export async function createRedemption(
  pool: Db,
  userId: number,
  productId: string,
  method: "delivery" | "vault_pickup",
  qty: number,
) {
  const product = REDEMPTION_PRODUCTS.find((item) => item.id === productId);
  if (!product || qty < 1 || qty > 20) throw new LedgerError("VALIDATION");
  const metalMg = BigInt(Math.round(product.grams * 1000)) * BigInt(qty);
  const live = await redemptionFees(pool, product.id);
  const feeUsd = live.fee + (method === "delivery" ? live.delivery : 0);
  const feeUusd = BigInt(feeUsd) * 1_000_000n * BigInt(qty);
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO redemptions (id, user_id, product, method, qty, metal_mg, fee_uusd, status, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'requested','已受理，等待模拟金库确认')`,
    [id, userId, product.id, method, qty, metalMg.toString(), feeUusd.toString()],
  );
  return redemptionById(pool, userId, id);
}

export async function listRedemptions(pool: Db, userId: number) {
  const rows = await pool.query(
    `SELECT id, product, method, qty, metal_mg::text, fee_uusd::text, status, detail, created_at, updated_at
     FROM redemptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 40`,
    [userId],
  );
  return rows.rows;
}

async function redemptionById(pool: Db, userId: number, id: string) {
  const rows = await pool.query(
    `SELECT id, product, method, qty, metal_mg::text, fee_uusd::text, status, detail, created_at, updated_at
     FROM redemptions WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows.rows[0];
}

export async function advanceWorkflows(pool: Db): Promise<void> {
  const wait = `${stepMs()} milliseconds`;
  await pool.query(
    `UPDATE rail_transfers SET status = 'processing', detail = '模拟银行处理中', updated_at = now()
     WHERE status = 'submitted' AND updated_at < now() - $1::interval`,
    [wait],
  );
  await pool.query(
    `UPDATE redemptions SET status = 'processing', detail = '模拟金库锁定货品', updated_at = now()
     WHERE status = 'requested' AND updated_at < now() - $1::interval`,
    [wait],
  );

  const rails = await pool.query(
    `SELECT id, user_id, direction, amount_uusd FROM rail_transfers
     WHERE status = 'processing' AND updated_at < now() - $1::interval`,
    [wait],
  );
  for (const row of rails.rows) {
    const customer = await loadCustomer(pool, Number(row.user_id));
    if (!customer) {
      await pool.query(`UPDATE rail_transfers SET status = 'failed', detail = 'KYC_REQUIRED', updated_at = now() WHERE id = $1`, [row.id]);
      continue;
    }
    try {
      await withTx(pool, async (client) => {
        const locked = await client.query(`SELECT status FROM rail_transfers WHERE id = $1 FOR UPDATE`, [row.id]);
        if (locked.rows[0]?.status !== "processing") return;
        if (row.direction === "deposit") await deposit(client, customer, "USD", BigInt(row.amount_uusd));
        else await withdraw(client, customer, "USD", BigInt(row.amount_uusd));
        await client.query(
          `UPDATE rail_transfers SET status = 'settled', detail = '模拟银行已完成', updated_at = now() WHERE id = $1`,
          [row.id],
        );
      });
      if (row.direction === "deposit") {
        try {
          await onDepositCredited(pool, Number(row.user_id), "USD", String(row.amount_uusd));
        } catch (err) {
          console.error("deposit notice", err);
        }
      }
    } catch (err) {
      const code = err instanceof LedgerError ? err.code : "FAILED";
      await pool.query(`UPDATE rail_transfers SET status = 'failed', detail = $2, updated_at = now() WHERE id = $1 AND status = 'processing'`, [
        row.id,
        code,
      ]);
    }
  }

  const redemptions = await pool.query(
    `SELECT id, user_id, metal_mg, fee_uusd FROM redemptions
     WHERE status = 'processing' AND updated_at < now() - $1::interval`,
    [wait],
  );
  for (const row of redemptions.rows) {
    const customer: CustomerRef | null = await loadCustomer(pool, Number(row.user_id));
    if (!customer) {
      await pool.query(`UPDATE redemptions SET status = 'failed', detail = 'KYC_REQUIRED', updated_at = now() WHERE id = $1`, [row.id]);
      continue;
    }
    try {
      await withTx(pool, async (client) => {
        const locked = await client.query(`SELECT status FROM redemptions WHERE id = $1 FOR UPDATE`, [row.id]);
        if (locked.rows[0]?.status !== "processing") return;
        if (BigInt(row.fee_uusd) > 0n) await withdraw(client, customer, "USD", BigInt(row.fee_uusd));
        await withdraw(client, customer, "XAU", BigInt(row.metal_mg));
        await client.query(
          `UPDATE redemptions SET status = 'ready', detail = '可提货或待配送（模拟）', updated_at = now() WHERE id = $1`,
          [row.id],
        );
      });
    } catch (err) {
      const code = err instanceof LedgerError ? err.code : "FAILED";
      await pool.query(
        `UPDATE redemptions SET status = 'failed', detail = $2, updated_at = now() WHERE id = $1 AND status = 'processing'`,
        [row.id, code],
      );
    }
  }

  await pool.query(
    `UPDATE crypto_transfers
     SET confirmations = LEAST(required_confirmations, confirmations + 1),
         status = 'processing',
         detail = '模拟链上确认中',
         updated_at = now()
     WHERE status = 'submitted' AND updated_at < now() - $1::interval`,
    [wait],
  );
  await pool.query(
    `UPDATE crypto_transfers
     SET confirmations = LEAST(required_confirmations, confirmations + 1),
         detail = '模拟链上确认中',
         updated_at = now()
     WHERE status = 'processing' AND confirmations < required_confirmations AND updated_at < now() - $1::interval`,
    [wait],
  );
  const cryptos = await pool.query(
    `SELECT id, user_id, asset, direction, amount FROM crypto_transfers
     WHERE status = 'processing' AND confirmations >= required_confirmations AND updated_at < now() - $1::interval`,
    [wait],
  );
  for (const row of cryptos.rows) {
    const customer = await loadCustomer(pool, Number(row.user_id));
    if (!customer) {
      await pool.query(`UPDATE crypto_transfers SET status = 'failed', detail = 'KYC_REQUIRED', updated_at = now() WHERE id = $1`, [row.id]);
      continue;
    }
    try {
      await withTx(pool, async (client) => {
        const locked = await client.query(`SELECT status FROM crypto_transfers WHERE id = $1 FOR UPDATE`, [row.id]);
        if (locked.rows[0]?.status !== "processing") return;
        if (row.direction === "deposit") await deposit(client, customer, row.asset, BigInt(row.amount));
        else await withdraw(client, customer, row.asset, BigInt(row.amount));
        await client.query(
          `UPDATE crypto_transfers SET status = 'settled', detail = '模拟到账（非真实链）', updated_at = now() WHERE id = $1`,
          [row.id],
        );
      });
      if (row.direction === "deposit") {
        try {
          await onDepositCredited(pool, Number(row.user_id), String(row.asset), String(row.amount));
        } catch (err) {
          console.error("deposit notice", err);
        }
      }
    } catch (err) {
      const code = err instanceof LedgerError ? err.code : "FAILED";
      await pool.query(`UPDATE crypto_transfers SET status = 'failed', detail = $2, updated_at = now() WHERE id = $1 AND status = 'processing'`, [
        row.id,
        code,
      ]);
    }
  }
  await pool.query(
    `UPDATE deposit_records d
     SET status = CASE c.status
           WHEN 'submitted' THEN 'pending'
           WHEN 'processing' THEN 'confirming'
           WHEN 'settled' THEN 'credited'
           WHEN 'failed' THEN 'flagged'
           ELSE d.status
         END,
         confirmations = c.confirmations
     FROM crypto_transfers c
     WHERE d.id = c.id::text AND c.direction = 'deposit'`,
  );
}

export async function createCrypto(
  pool: Db,
  userId: number,
  input: { asset: string; network: string; direction: "deposit" | "withdraw"; amount: bigint },
): Promise<Record<string, unknown>> {
  const id = crypto.randomUUID();
  const address = `mx:${input.asset}:${input.network}:${userId}`;
  const tx = `0x${id.replace(/-/g, "").slice(0, 40)}`;
  await pool.query(
    `INSERT INTO crypto_transfers (id, user_id, asset, network, direction, amount, address, tx_hash, status, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'submitted','模拟地址，不会广播到公链')`,
    [id, userId, input.asset, input.network, input.direction, input.amount.toString(), address, tx],
  );
  if (input.direction === "deposit") {
    await recordDeposit(pool, {
      id,
      userId,
      asset: input.asset,
      network: input.network,
      amount: input.amount.toString(),
      status: "pending",
      txid: tx,
      required: 3,
    });
  }
  const rows = await pool.query(`SELECT * FROM crypto_transfers WHERE id = $1`, [id]);
  return rows.rows[0];
}

export async function listCrypto(pool: Db, userId: number) {
  const rows = await pool.query(
    `SELECT id, asset, network, direction, amount::text, address, tx_hash, confirmations, required_confirmations, status, detail, created_at
     FROM crypto_transfers WHERE user_id = $1 ORDER BY created_at DESC LIMIT 40`,
    [userId],
  );
  return rows.rows;
}
