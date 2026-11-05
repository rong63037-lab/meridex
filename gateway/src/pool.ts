import { createHash, randomBytes, randomUUID } from "node:crypto";
import QRCode from "qrcode";
import type { PoolClient } from "pg";
import { addressHash, canonicalPair, demoAddress, depositGuidePath, explainAddress, normalizeAddress, pairMin, PAIRS } from "./addresses.js";
import { generateTotpSecret, verifyTotp } from "./crypto.js";
import type { Db } from "./db.js";
import { withTx } from "./db.js";
import { PlatformError } from "./errors.js";

const LOCK_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

type RowIn = { asset: string; network: string; address: string; memo?: string | null; min?: string | null };

export type PoolAddress = {
  asset: string;
  network: string;
  status: "ready" | "preparing";
  address: string | null;
  memo: string | null;
  min: string | null;
  addressHash: string | null;
  warning: string;
  hint: string;
  guidePath: string;
};

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function notify(db: Db | PoolClient, userId: number, channel: "email" | "inapp", title: string, body: string) {
  await db.query(
    `INSERT INTO notification_outbox (id, user_id, channel, title, body, provider, status)
     VALUES ($1,$2,$3,$4,$5,$6,'mock_sent')`,
    [randomUUID(), userId, channel, title, body, channel === "email" ? "mock-email" : "inapp"],
  );
}

export async function writePoolAuditSafe(
  pool: Db,
  row: {
    actorId: number | null;
    action: string;
    ip?: string | null;
    customerId?: number | null;
    asset?: string | null;
    network?: string | null;
    oldHash?: string | null;
    newHash?: string | null;
    detail?: string | null;
  },
) {
  await writeAudit(pool, row);
}

async function writeAudit(
  db: Db | PoolClient,
  row: {
    actorId: number | null;
    action: string;
    ip?: string | null;
    batchId?: string | null;
    poolId?: number | null;
    customerId?: number | null;
    asset?: string | null;
    network?: string | null;
    oldHash?: string | null;
    newHash?: string | null;
    detail?: string | null;
  },
) {
  await db.query(
    `INSERT INTO pool_audit (actor_id, action, ip, batch_id, pool_id, customer_id, asset, network, old_hash, new_hash, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      row.actorId,
      row.action,
      row.ip ?? null,
      row.batchId ?? null,
      row.poolId ?? null,
      row.customerId ?? null,
      row.asset ?? null,
      row.network ?? null,
      row.oldHash ?? null,
      row.newHash ?? null,
      (row.detail ?? "").slice(0, 240) || null,
    ],
  );
}

export async function requireFreshTotp(pool: Db, userId: number, code: string | undefined) {
  const lock = await pool.query(`SELECT fails, locked_until FROM totp_lockouts WHERE user_id = $1`, [userId]);
  const until = lock.rows[0]?.locked_until ? new Date(lock.rows[0].locked_until as string) : null;
  if (until && until.getTime() > Date.now()) throw new PlatformError("TOTP_LOCKED", 429);
  if (!code || !code.trim()) throw new PlatformError("TOTP_REQUIRED", 401);
  const user = await pool.query(`SELECT totp_secret, recovery_hashes FROM users WHERE id = $1`, [userId]);
  if (!user.rowCount) throw new PlatformError("NOT_FOUND", 404);
  const secret = String(user.rows[0].totp_secret);
  let ok = verifyTotp(secret, code.trim());
  if (!ok) {
    const hashes = JSON.parse(String(user.rows[0].recovery_hashes || "[]")) as string[];
    const digest = sha(code.trim().toUpperCase());
    const idx = hashes.indexOf(digest);
    if (idx >= 0) {
      ok = true;
      hashes.splice(idx, 1);
      await pool.query(`UPDATE users SET recovery_hashes = $2 WHERE id = $1`, [userId, JSON.stringify(hashes)]);
    }
  }
  if (!ok) {
    const fails = Number(lock.rows[0]?.fails ?? 0) + 1;
    const locked = fails >= LOCK_FAILS ? new Date(Date.now() + LOCK_MS).toISOString() : null;
    await pool.query(
      `INSERT INTO totp_lockouts (user_id, fails, locked_until) VALUES ($1,$2,$3)
       ON CONFLICT (user_id) DO UPDATE SET fails = $2, locked_until = $3`,
      [userId, fails, locked],
    );
    throw new PlatformError(locked ? "TOTP_LOCKED" : "INVALID_TOTP", locked ? 429 : 401);
  }
  await pool.query(
    `INSERT INTO totp_lockouts (user_id, fails, locked_until) VALUES ($1,0,NULL)
     ON CONFLICT (user_id) DO UPDATE SET fails = 0, locked_until = NULL`,
    [userId],
  );
}

export async function assertPoolOwner(pool: Db, userId: number) {
  const row = await pool.query(`SELECT address_pool_owner FROM users WHERE id = $1`, [userId]);
  if (!row.rows[0]?.address_pool_owner) throw new PlatformError("NOT_POOL_OWNER", 403);
}

async function taken(db: Db | PoolClient, address: string): Promise<boolean> {
  const hash = addressHash(address);
  const poolHit = await db.query(`SELECT 1 FROM address_pool WHERE address_hash = $1 OR lower(address) = lower($2) LIMIT 1`, [
    hash,
    address.trim(),
  ]);
  if (poolHit.rowCount) return true;
  const hist = await db.query(`SELECT 1 FROM address_history WHERE address_hash = $1 OR lower(address) = lower($2) LIMIT 1`, [
    hash,
    address.trim(),
  ]);
  return Boolean(hist.rowCount);
}

async function noteStock(db: Db | PoolClient, actorId: number | null, asset: string, network: string) {
  const count = await db.query(
    `SELECT count(*)::int AS n FROM address_pool WHERE asset = $1 AND network = $2 AND status = 'available'`,
    [asset, network],
  );
  const thresholdRow = await db.query(`SELECT threshold FROM pool_thresholds WHERE asset = $1 AND network = $2`, [asset, network]);
  const threshold = Number(thresholdRow.rows[0]?.threshold ?? 2);
  const available = Number(count.rows[0].n);
  if (available >= threshold) return;
  const recent = await db.query(
    `SELECT 1 FROM pool_audit WHERE action = 'low_stock' AND asset = $1 AND network = $2 AND created_at > now() - interval '1 hour' LIMIT 1`,
    [asset, network],
  );
  if (recent.rowCount) return;
  await writeAudit(db, {
    actorId,
    action: "low_stock",
    asset,
    network,
    detail: `available ${available} below ${threshold}`,
  });
  const owner = await db.query(`SELECT id FROM users WHERE address_pool_owner = true LIMIT 1`);
  const ownerId = owner.rows[0]?.id as number | undefined;
  if (ownerId) {
    await db.query(
      `INSERT INTO surv_alerts (id, rule_id, user_id, severity, demo, detail) VALUES ($1,'pool_low',$2,'medium',true,$3)`,
      [randomUUID(), ownerId, `${asset} ${network} available ${available} / threshold ${threshold}`],
    );
    await notify(db, ownerId, "inapp", "MERIDEX · 安全 · 地址池库存", `${asset} ${network} 可用地址 ${available}，低于阈值 ${threshold}。`);
    await notify(db, ownerId, "email", "MERIDEX · 安全 · 地址池库存", `${asset} ${network} stock ${available} is below ${threshold}.`);
  }
}

export async function importAddresses(pool: Db, actorId: number, ip: string, rows: RowIn[]) {
  if (!rows.length || rows.length > 200) throw new PlatformError("VALIDATION");
  const batchId = randomUUID();
  const accepted: { asset: string; network: string; address: string; memo: string | null; min: string }[] = [];
  const rejected: { asset: string; network: string; address: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const pair = canonicalPair(row.asset ?? "", row.network ?? "");
    const address = (row.address ?? "").trim();
    if (!pair) {
      rejected.push({ asset: row.asset, network: row.network, address, reason: "unknown network" });
      continue;
    }
    const reason = explainAddress(pair.asset, pair.network, address);
    if (reason) {
      rejected.push({ asset: pair.asset, network: pair.network, address, reason });
      continue;
    }
    const key = addressHash(address);
    if (seen.has(key)) {
      rejected.push({ asset: pair.asset, network: pair.network, address, reason: "duplicate" });
      continue;
    }
    seen.add(key);
    accepted.push({
      asset: pair.asset,
      network: pair.network,
      address: address.trim(),
      memo: row.memo?.trim() ? row.memo.trim().slice(0, 32) : null,
      min: row.min?.trim() || pairMin(pair.asset, pair.network),
    });
  }
  const stored: { id: number; asset: string; network: string; addressHash: string }[] = [];
  await withTx(pool, async (client) => {
    for (const row of accepted) {
      if (await taken(client, row.address)) {
        rejected.push({ asset: row.asset, network: row.network, address: row.address, reason: "duplicate" });
        continue;
      }
      const inserted = await client.query(
        `INSERT INTO address_pool (asset, network, address, address_hash, memo, min_amount, status, batch_id)
         VALUES ($1,$2,$3,$4,$5,$6,'available',$7) RETURNING id`,
        [row.asset, row.network, row.address, addressHash(row.address), row.memo, row.min, batchId],
      );
      stored.push({ id: Number(inserted.rows[0].id), asset: row.asset, network: row.network, addressHash: addressHash(row.address) });
      await writeAudit(client, {
        actorId,
        action: "import",
        ip,
        batchId,
        poolId: Number(inserted.rows[0].id),
        asset: row.asset,
        network: row.network,
        newHash: addressHash(row.address),
        detail: "imported",
      });
    }
    const pairs = new Set(stored.map((row) => `${row.asset}|${row.network}`));
    for (const key of pairs) {
      const [asset, network] = key.split("|");
      await noteStock(client, actorId, asset, network);
    }
  });
  return { batchId, accepted: stored.length, rejected };
}

export async function previewAddresses(
  pool: Db,
  rows: { line?: number; asset?: string; network?: string; address?: string }[],
) {
  if (rows.length > 200) throw new PlatformError("VALIDATION");
  const seen = new Set<string>();
  const lines: { line: number; asset: string; network: string; address: string; ok: boolean; reason: string | null }[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const line = row.line ?? i + 1;
    const address = (row.address ?? "").trim();
    const pair = canonicalPair(row.asset ?? "", row.network ?? "");
    if (!pair) {
      lines.push({ line, asset: row.asset ?? "", network: row.network ?? "", address, ok: false, reason: "unknown network" });
      continue;
    }
    const reason = explainAddress(pair.asset, pair.network, address);
    if (reason) {
      lines.push({ line, asset: pair.asset, network: pair.network, address, ok: false, reason });
      continue;
    }
    const key = addressHash(address);
    if (seen.has(key) || (await taken(pool, address))) {
      lines.push({ line, asset: pair.asset, network: pair.network, address, ok: false, reason: "duplicate" });
      continue;
    }
    seen.add(key);
    lines.push({ line, asset: pair.asset, network: pair.network, address, ok: true, reason: null });
  }
  return { ready: lines.filter((line) => line.ok).length, lines };
}

export async function editPoolAddress(pool: Db, actorId: number, ip: string, id: number, nextAddress: string) {
  const address = nextAddress.trim();
  const notice = await withTx(pool, async (client) => {
    const found = await client.query(`SELECT * FROM address_pool WHERE id = $1 FOR UPDATE`, [id]);
    if (!found.rowCount) throw new PlatformError("NOT_FOUND", 404);
    const row = found.rows[0];
    if (row.status === "retired") throw new PlatformError("ADDRESS_RETIRED", 409);
    const reason = explainAddress(String(row.asset), String(row.network), address);
    if (reason) throw new PlatformError("VALIDATION");
    if (normalizeAddress(address) === normalizeAddress(String(row.address))) throw new PlatformError("VALIDATION");
    if (await taken(client, address)) throw new PlatformError("DUPLICATE_ADDRESS", 409);
    const oldHash = String(row.address_hash);
    const newHash = addressHash(address);
    let pending: { userId: number; asset: string; network: string; oldHash: string; newHash: string; email: string } | null = null;
    if (row.status === "assigned" && row.user_id) {
      const existingHist = await client.query(
        `SELECT id FROM address_history WHERE pool_id = $1 AND address_hash = $2`,
        [id, oldHash],
      );
      if (existingHist.rowCount) {
        await client.query(
          `UPDATE address_history SET active = false, retired_at = now() WHERE pool_id = $1 AND address_hash = $2`,
          [id, oldHash],
        );
      } else {
        await client.query(
          `INSERT INTO address_history (user_id, asset, network, address, address_hash, pool_id, active, retired_at)
           VALUES ($1,$2,$3,$4,$5,$6,false,now())`,
          [row.user_id, row.asset, row.network, row.address, oldHash, id],
        );
      }
      await client.query(
        `INSERT INTO address_history (user_id, asset, network, address, address_hash, pool_id, active)
         VALUES ($1,$2,$3,$4,$5,$6,true)`,
        [row.user_id, row.asset, row.network, address, newHash, id],
      );
      const who = await client.query(`SELECT email FROM users WHERE id = $1`, [row.user_id]);
      pending = {
        userId: Number(row.user_id),
        asset: String(row.asset),
        network: String(row.network),
        oldHash,
        newHash,
        email: String(who.rows[0]?.email ?? ""),
      };
    }
    await client.query(`UPDATE address_pool SET address = $2, address_hash = $3, updated_at = now() WHERE id = $1`, [
      id,
      address,
      newHash,
    ]);
    await writeAudit(client, {
      actorId,
      action: "edit",
      ip,
      poolId: id,
      customerId: row.user_id ? Number(row.user_id) : null,
      asset: String(row.asset),
      network: String(row.network),
      oldHash,
      newHash,
      detail: row.status === "assigned" ? "assigned address replaced; previous kept for attribution" : "available address edited",
    });
    return pending;
  });
  if (notice) {
    const owner = await pool.query(`SELECT id FROM users WHERE address_pool_owner = true LIMIT 1`);
    const ownerId = Number(owner.rows[0]?.id ?? actorId);
    await notify(
      pool,
      notice.userId,
      "inapp",
      "MERIDEX · 资金 · 充值地址已更换",
      `${notice.asset} ${notice.network} 的充值地址已更换。请只使用资金页上的新地址。旧地址仍用于识别已经转出的款项，不会在聊天中另行发送。`,
    );
    const alert = `${notice.asset} ${notice.network} for ${notice.email} changed. old ${notice.oldHash} new ${notice.newHash}`;
    await notify(pool, ownerId, "inapp", "MERIDEX · 安全 · 充值地址变更", alert);
    await notify(pool, ownerId, "email", "MERIDEX · 安全 · 充值地址变更", alert);
  }
  return { ok: true };
}

export async function retirePoolAddress(pool: Db, actorId: number, ip: string, id: number) {
  let userId: number | null = null;
  let asset = "";
  let network = "";
  await withTx(pool, async (client) => {
    const found = await client.query(`SELECT * FROM address_pool WHERE id = $1 FOR UPDATE`, [id]);
    if (!found.rowCount) throw new PlatformError("NOT_FOUND", 404);
    const row = found.rows[0];
    if (row.status === "retired") return;
    await client.query(`UPDATE address_pool SET status = 'retired', updated_at = now() WHERE id = $1`, [id]);
    await client.query(
      `UPDATE address_history SET active = false, retired_at = now() WHERE pool_id = $1 AND active = true`,
      [id],
    );
    if (row.user_id) {
      const hist = await client.query(`SELECT 1 FROM address_history WHERE pool_id = $1 AND address_hash = $2`, [id, row.address_hash]);
      if (!hist.rowCount) {
        await client.query(
          `INSERT INTO address_history (user_id, asset, network, address, address_hash, pool_id, active, retired_at)
           VALUES ($1,$2,$3,$4,$5,$6,false,now())`,
          [row.user_id, row.asset, row.network, row.address, row.address_hash, id],
        );
      }
      userId = Number(row.user_id);
      asset = String(row.asset);
      network = String(row.network);
    }
    await writeAudit(client, {
      actorId,
      action: "retire",
      ip,
      poolId: id,
      customerId: row.user_id ? Number(row.user_id) : null,
      asset: String(row.asset),
      network: String(row.network),
      oldHash: String(row.address_hash),
      detail: "retired; mapping kept",
    });
    await noteStock(client, actorId, String(row.asset), String(row.network));
  });
  if (userId) {
    await notify(pool, userId, "inapp", "MERIDEX · 资金 · 充值地址已停用", `${asset} ${network} 的旧充值地址已停用。请打开资金页查看是否已分配新地址。`);
  }
  return { ok: true };
}

export async function deletePoolAddress(pool: Db, actorId: number, ip: string, id: number) {
  await withTx(pool, async (client) => {
    const found = await client.query(`SELECT * FROM address_pool WHERE id = $1 FOR UPDATE`, [id]);
    if (!found.rowCount) throw new PlatformError("NOT_FOUND", 404);
    const row = found.rows[0];
    if (row.status !== "available") throw new PlatformError("ADDRESS_IN_USE", 409);
    await client.query(`DELETE FROM address_pool WHERE id = $1`, [id]);
    await writeAudit(client, {
      actorId,
      action: "delete",
      ip,
      poolId: id,
      asset: String(row.asset),
      network: String(row.network),
      oldHash: String(row.address_hash),
      detail: "available address deleted",
    });
    await noteStock(client, actorId, String(row.asset), String(row.network));
  });
  return { ok: true };
}

export async function assignSpecific(pool: Db, actorId: number, ip: string, poolId: number, customerEmail: string) {
  const customer = await pool.query(`SELECT id FROM users WHERE email = $1 AND role = 'customer'`, [customerEmail.trim()]);
  if (!customer.rowCount) throw new PlatformError("NOT_FOUND", 404);
  const userId = Number(customer.rows[0].id);
  await withTx(pool, async (client) => {
    const found = await client.query(`SELECT * FROM address_pool WHERE id = $1 FOR UPDATE`, [poolId]);
    if (!found.rowCount) throw new PlatformError("NOT_FOUND", 404);
    const row = found.rows[0];
    if (row.status !== "available") throw new PlatformError("ADDRESS_IN_USE", 409);
    const current = await client.query(
      `SELECT id, address_hash FROM address_pool WHERE user_id = $1 AND asset = $2 AND network = $3 AND status = 'assigned' FOR UPDATE`,
      [userId, row.asset, row.network],
    );
    if (current.rowCount) {
      await client.query(`UPDATE address_pool SET status = 'retired', updated_at = now() WHERE id = $1`, [current.rows[0].id]);
      await client.query(`UPDATE address_history SET active = false, retired_at = now() WHERE pool_id = $1 AND active = true`, [
        current.rows[0].id,
      ]);
      await writeAudit(client, {
        actorId,
        action: "retire",
        ip,
        poolId: Number(current.rows[0].id),
        customerId: userId,
        asset: String(row.asset),
        network: String(row.network),
        oldHash: String(current.rows[0].address_hash),
        detail: "replaced by manual assignment",
      });
    }
    await client.query(`UPDATE address_pool SET status = 'assigned', user_id = $2, updated_at = now() WHERE id = $1`, [poolId, userId]);
    await client.query(
      `INSERT INTO address_history (user_id, asset, network, address, address_hash, pool_id, active)
       VALUES ($1,$2,$3,$4,$5,$6,true)`,
      [userId, row.asset, row.network, row.address, row.address_hash, poolId],
    );
    await writeAudit(client, {
      actorId,
      action: "assign",
      ip,
      poolId,
      customerId: userId,
      asset: String(row.asset),
      network: String(row.network),
      newHash: String(row.address_hash),
      detail: "manual assignment",
    });
    await noteStock(client, actorId, String(row.asset), String(row.network));
  });
  return { ok: true };
}

export async function assignNext(pool: Db, userId: number, asset: string, network: string): Promise<PoolAddress> {
  const pair = canonicalPair(asset, network);
  if (!pair) throw new PlatformError("VALIDATION");
  const warning = `Send only ${pair.asset} on ${pair.network}. A wrong network can lose the transfer.`;
  const hint = "This address is also always available on your Deposit page";
  const grabbed = await withTx(pool, async (client) => {
    const existing = await client.query(
      `SELECT id, address, memo, min_amount, address_hash FROM address_pool
       WHERE user_id = $1 AND asset = $2 AND network = $3 AND status = 'assigned' FOR UPDATE`,
      [userId, pair.asset, pair.network],
    );
    if (existing.rowCount) return existing.rows[0];
    const next = await client.query(
      `UPDATE address_pool SET status = 'assigned', user_id = $1, updated_at = now()
       WHERE id = (
         SELECT id FROM address_pool
         WHERE asset = $2 AND network = $3 AND status = 'available'
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING id, address, memo, min_amount, address_hash`,
      [userId, pair.asset, pair.network],
    );
    if (!next.rowCount) return null;
    const row = next.rows[0];
    await client.query(
      `INSERT INTO address_history (user_id, asset, network, address, address_hash, pool_id, active)
       VALUES ($1,$2,$3,$4,$5,$6,true)`,
      [userId, pair.asset, pair.network, row.address, row.address_hash, row.id],
    );
    await writeAudit(client, {
      actorId: null,
      action: "assign",
      customerId: userId,
      poolId: Number(row.id),
      asset: pair.asset,
      network: pair.network,
      newHash: String(row.address_hash),
      detail: "next available",
    });
    await noteStock(client, null, pair.asset, pair.network);
    return row;
  });
  if (!grabbed) {
    return {
      asset: pair.asset,
      network: pair.network,
      status: "preparing",
      address: null,
      memo: null,
      min: pairMin(pair.asset, pair.network),
      addressHash: null,
      warning,
      hint,
      guidePath: depositGuidePath(pair.asset, pair.network),
    };
  }
  return {
    asset: pair.asset,
    network: pair.network,
    status: "ready",
    address: String(grabbed.address),
    memo: (grabbed.memo as string | null) ?? null,
    min: String(grabbed.min_amount),
    addressHash: String(grabbed.address_hash),
    warning,
    hint,
    guidePath: depositGuidePath(pair.asset, pair.network),
  };
}

export async function customerAddresses(pool: Db, userId: number): Promise<PoolAddress[]> {
  const out: PoolAddress[] = [];
  for (const pair of PAIRS) out.push(await assignNext(pool, userId, pair.asset, pair.network));
  return out;
}

export function maskToken(value: string): string {
  if (value.length <= 8) return "••••";
  if (value.startsWith("0x") || value.toLowerCase().startsWith("bc1") || value.toLowerCase().startsWith("tb1") || value.startsWith("T")) {
    return `${value.slice(0, 6)}…${value.slice(-4)}`;
  }
  return `••••${value.slice(-4)}`;
}

export async function listPool(pool: Db, full: boolean) {
  const rows = await pool.query(
    `SELECT p.id, p.asset, p.network, p.address, p.address_hash, p.memo, p.min_amount, p.status, p.batch_id, p.updated_at, u.email
     FROM address_pool p LEFT JOIN users u ON u.id = p.user_id
     ORDER BY p.asset, p.network, p.id`,
  );
  const stock = await pool.query(
    `SELECT asset, network,
            count(*) FILTER (WHERE status = 'available')::int AS available,
            count(*) FILTER (WHERE status = 'assigned')::int AS assigned
     FROM address_pool GROUP BY asset, network ORDER BY asset, network`,
  );
  const thresholds = await pool.query(`SELECT asset, network, threshold FROM pool_thresholds`);
  const thresholdOf = new Map(thresholds.rows.map((row) => [`${row.asset}|${row.network}`, Number(row.threshold)]));
  return {
    ownerView: full,
    rows: rows.rows.map((row) => ({
      id: Number(row.id),
      asset: row.asset as string,
      network: row.network as string,
      address: full ? (row.address as string) : maskToken(String(row.address)),
      addressHash: row.address_hash as string,
      memo: row.memo as string | null,
      min: row.min_amount as string,
      status: row.status as string,
      email: (row.email as string | null) ?? null,
      batchId: row.batch_id as string | null,
    })),
    stock: stock.rows.map((row) => {
      const threshold = thresholdOf.get(`${row.asset}|${row.network}`) ?? 2;
      const available = Number(row.available);
      return {
        asset: row.asset as string,
        network: row.network as string,
        available,
        assigned: Number(row.assigned),
        threshold,
        low: available < threshold,
      };
    }),
  };
}

export async function listPoolAudit(pool: Db) {
  const rows = await pool.query(
    `SELECT a.id, a.action, a.ip, a.batch_id, a.asset, a.network, a.old_hash, a.new_hash, a.detail, a.created_at,
            u.email AS actor, c.email AS customer
     FROM pool_audit a
     LEFT JOIN users u ON u.id = a.actor_id
     LEFT JOIN users c ON c.id = a.customer_id
     ORDER BY a.id DESC LIMIT 80`,
  );
  return rows.rows;
}

export async function setThreshold(pool: Db, actorId: number, ip: string, asset: string, network: string, threshold: number) {
  const pair = canonicalPair(asset, network);
  if (!pair || !Number.isInteger(threshold) || threshold < 0 || threshold > 1000) throw new PlatformError("VALIDATION");
  await pool.query(
    `INSERT INTO pool_thresholds (asset, network, threshold) VALUES ($1,$2,$3)
     ON CONFLICT (asset, network) DO UPDATE SET threshold = $3`,
    [pair.asset, pair.network, threshold],
  );
  await noteStock(pool, actorId, pair.asset, pair.network);
  await writeAudit(pool, {
    actorId,
    action: "threshold",
    ip,
    asset: pair.asset,
    network: pair.network,
    detail: `threshold ${threshold}`,
  });
  return { ok: true };
}

export async function attributeAddress(pool: Db, address: string) {
  const rows = await pool.query(
    `SELECT h.address_hash, h.asset, h.network, h.active, h.assigned_at, h.retired_at, u.email
     FROM address_history h JOIN users u ON u.id = h.user_id
     WHERE h.address_hash = $1 OR lower(h.address) = lower($2)
     ORDER BY h.id DESC LIMIT 5`,
    [addressHash(address), address.trim()],
  );
  return rows.rows;
}

export async function startTotpEnrol(pool: Db, userId: number, currentCode: string | undefined) {
  await requireFreshTotp(pool, userId, currentCode);
  const secret = generateTotpSecret();
  const codes = Array.from({ length: 8 }, () => randomBytes(5).toString("hex").slice(0, 8).toUpperCase());
  const hashes = codes.map((code) => sha(code));
  await pool.query(`UPDATE users SET totp_pending = $2, recovery_pending = $3 WHERE id = $1`, [
    userId,
    secret,
    JSON.stringify(hashes),
  ]);
  const email = await pool.query(`SELECT email FROM users WHERE id = $1`, [userId]);
  const otpauth = `otpauth://totp/MERIDEX:${encodeURIComponent(String(email.rows[0].email))}?secret=${secret}&issuer=MERIDEX&algorithm=SHA1&digits=6&period=30`;
  const qrDataUrl = await QRCode.toDataURL(otpauth, { margin: 1, width: 180 });
  return { otpauth, qrDataUrl, recoveryCodes: codes };
}

export async function confirmTotpEnrol(pool: Db, userId: number, code: string | undefined) {
  if (!code) throw new PlatformError("TOTP_REQUIRED", 401);
  const row = await pool.query(`SELECT totp_pending, recovery_pending FROM users WHERE id = $1`, [userId]);
  const pending = row.rows[0]?.totp_pending as string | null;
  if (!pending) throw new PlatformError("VALIDATION");
  if (!verifyTotp(pending, code.trim())) throw new PlatformError("INVALID_TOTP", 401);
  await pool.query(
    `UPDATE users SET totp_secret = $2, totp_pending = NULL, recovery_hashes = COALESCE(recovery_pending, '[]'), recovery_pending = NULL WHERE id = $1`,
    [userId, pending],
  );
  await writeAudit(pool, { actorId: userId, action: "totp_enrol", detail: "authenticator replaced" });
  return { ok: true };
}

export async function seedAddressPool(pool: Db, ownerId: number) {
  for (const pair of PAIRS) {
    await pool.query(
      `INSERT INTO pool_thresholds (asset, network, threshold) VALUES ($1,$2,2) ON CONFLICT (asset, network) DO NOTHING`,
      [pair.asset, pair.network],
    );
  }
  const count = await pool.query(`SELECT count(*)::int AS n FROM address_pool`);
  if (Number(count.rows[0].n) > 0) return;
  const rows: RowIn[] = [];
  for (const pair of PAIRS) {
    for (let n = 1; n <= 8; n += 1) {
      rows.push({ asset: pair.asset, network: pair.network, address: demoAddress(pair.asset, pair.network, n), min: pair.min });
    }
  }
  await importAddresses(pool, ownerId, "127.0.0.1", rows);
}

export async function linkedPoolAddresses(pool: Db, userId: number): Promise<string[]> {
  const rows = await pool.query(
    `SELECT address FROM address_pool WHERE user_id = $1
     UNION SELECT address FROM address_history WHERE user_id = $1`,
    [userId],
  );
  return rows.rows.map((row) => String(row.address));
}
