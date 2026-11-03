/** Manual deposit credits. Customers can only file a claim. The ledger moves from this module. */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { requireFreshTotp } from "./pool.js";
import { adjustUsdMove, loadNumbers } from "./content.js";
import { withTx, type Db } from "./db.js";
import { PlatformError } from "./errors.js";
import { loadCatalog } from "./instruments.js";
import { deposit, depositReversal, LedgerError, type CustomerRef } from "./ledger.js";
import { loadCustomer } from "./trading.js";
import { assertLiveServicesEnabled, assertRealRails } from "./play.js";
import { formatScaled, parseScaled } from "./units.js";

export const ASSET_NETWORKS: Record<string, { decimals: number; networks: string[] }> = {
  USD: { decimals: 6, networks: ["Bank", "PayNow"] },
  USDT: { decimals: 6, networks: ["ERC20", "TRC20"] },
  BTC: { decimals: 8, networks: ["Bitcoin"] },
  ETH: { decimals: 8, networks: ["Ethereum"] },
  XAU: { decimals: 3, networks: ["Vault"] },
};

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

type Staff = { id: number; email: string; role: string };

export type ClaimRow = {
  id: number;
  userId: number;
  email?: string;
  asset: string;
  network: string;
  amount: string;
  reference: string;
  status: string;
  createdAt: string;
};

function uniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "23505";
}

function money(amount: bigint, decimals: number): string {
  const text = formatScaled(amount, decimals, decimals);
  if (decimals <= 2) return text;
  const [whole, frac = ""] = text.split(".");
  const trimmed = frac.replace(/0+$/, "");
  const keep = trimmed.length < 2 ? trimmed.padEnd(2, "0") : trimmed;
  return `${whole}.${keep}`;
}

export function normalizeReference(input: string): string {
  const value = input.trim();
  if (!REF_RE.test(value)) throw new PlatformError("VALIDATION");
  return value;
}

export function canonicalNetwork(asset: string, network: string): string {
  const spec = ASSET_NETWORKS[asset];
  if (!spec) throw new PlatformError("VALIDATION");
  const key = network.trim().toLowerCase();
  const hit = spec.networks.find((item) => item.toLowerCase() === key);
  if (!hit) throw new PlatformError("VALIDATION");
  return hit;
}

function journalRef(asset: string, reference: string): string {
  return `manual:${asset}:${reference}`;
}

async function assertCreditor(pool: Db, user: Staff): Promise<void> {
  if (user.role === "ops") return;
  const row = await pool.query(`SELECT address_pool_owner FROM users WHERE id = $1`, [user.id]);
  if (!row.rows[0]?.address_pool_owner) throw new PlatformError("FORBIDDEN", 403);
}

async function assertOwner(pool: Db, user: Staff): Promise<void> {
  const row = await pool.query(`SELECT address_pool_owner FROM users WHERE id = $1`, [user.id]);
  if (!row.rows[0]?.address_pool_owner) throw new PlatformError("FORBIDDEN", 403);
}

function notionalMicro(asset: string, gross: bigint): bigint {
  if (asset === "USD") return gross;
  const inst = loadCatalog().find((row) => row.base === asset && row.quote === "USD");
  if (!inst) throw new PlatformError("VALIDATION");
  return (gross * BigInt(inst.refPrice) * BigInt(inst.quoteScale)) / (BigInt(inst.qtyScale) * BigInt(inst.priceScale));
}

export async function quoteCredit(pool: Db, asset: string, amountText: string) {
  const spec = ASSET_NETWORKS[asset];
  if (!spec) throw new PlatformError("VALIDATION");
  let gross: bigint;
  try {
    gross = parseScaled(amountText, spec.decimals);
  } catch {
    throw new PlatformError("VALIDATION");
  }
  if (gross <= 0n) throw new PlatformError("VALIDATION");
  const numbers = await loadNumbers(pool);
  const min = numbers["deposit.minUsd"] ?? 0;
  const max = numbers["deposit.maxUsd"] ?? 0;
  const flagUsd = numbers["deposit.flagUsd"] ?? 0;
  let fee = 0n;
  let net = gross;
  if (asset === "USD") {
    net = await adjustUsdMove(pool, "deposit", gross);
    fee = gross - net;
  } else {
    const usd = Number(notionalMicro(asset, gross)) / 1_000_000;
    if (min > 0 && usd + 1e-9 < min) throw new PlatformError("AMOUNT_LIMIT");
    if (max > 0 && usd - 1e-9 > max) throw new PlatformError("AMOUNT_LIMIT");
  }
  const notion = notionalMicro(asset, gross);
  const flag = flagUsd > 0 && Number(notion) / 1_000_000 + 1e-9 >= flagUsd;
  return {
    gross,
    fee,
    net,
    decimals: spec.decimals,
    grossText: money(gross, spec.decimals),
    feeText: money(fee, spec.decimals),
    netText: money(net, spec.decimals),
    notionalUsd: (Number(notion) / 1_000_000).toFixed(2),
    flag,
    flagUsd,
    minUsd: min,
    maxUsd: max,
    feeUsd: numbers["deposit.feeUsd"] ?? 0,
  };
}

async function realCustomer(pool: Db, userId: number): Promise<CustomerRef> {
  if (!Number.isInteger(userId) || userId <= 0) throw new PlatformError("VALIDATION");
  await assertRealRails(pool, userId);
  const customer = await loadCustomer(pool, userId);
  if (!customer) throw new PlatformError("KYC_REQUIRED", 403);
  const role = await pool.query(`SELECT role FROM users WHERE id = $1`, [userId]);
  if (role.rows[0]?.role !== "customer") throw new PlatformError("VALIDATION");
  return customer;
}

export async function searchCustomers(pool: Db, staff: Staff, q: string) {
  await assertCreditor(pool, staff);
  const query = q.trim().slice(0, 120);
  if (query.length < 1) return { matches: [], internalTest: null };
  const like = `%${query}%`;
  const internal = await pool.query(
    `SELECT id, email, fund_id FROM users
     WHERE is_internal_test AND (
       lower(email) = lower($1) OR id::text = $1 OR fund_id ILIKE $1 OR coalesce(display_name, '') ILIKE $1
     )
     LIMIT 1`,
    [query],
  );
  const rows = await pool.query(
    `SELECT id, email, fund_id, display_name FROM users
     WHERE role = 'customer' AND is_internal_test = false
       AND (email ILIKE $1 OR fund_id ILIKE $1 OR coalesce(display_name, '') ILIKE $1 OR ($2 <> '' AND id::text = $2))
     ORDER BY id DESC
     LIMIT 8`,
    [like, /^\d+$/.test(query) ? query : ""],
  );
  return {
    matches: rows.rows.map((row) => ({
      id: Number(row.id),
      email: String(row.email),
      fundId: String(row.fund_id),
      name: row.display_name ? String(row.display_name) : "",
    })),
    internalTest: internal.rowCount
      ? { id: Number(internal.rows[0].id), email: String(internal.rows[0].email), fundId: String(internal.rows[0].fund_id) }
      : null,
  };
}

async function assigned(pool: Db, userId: number, asset: string, network: string) {
  if (asset === "USD") {
    const profile = await pool.query(
      `SELECT reference_code, bank_name, bank_account FROM deposit_profiles WHERE user_id = $1`,
      [userId],
    );
    const row = profile.rows[0];
    return {
      status: row ? "ready" : "preparing",
      address: row ? String(row.bank_account) : null,
      memo: row ? String(row.reference_code) : null,
      label: row ? String(row.bank_name) : null,
      network,
    };
  }
  if (asset === "XAU") {
    return { status: "vault", address: null, memo: null, label: "Vault", network: "Vault" };
  }
  const hit = await pool.query(
    `SELECT address, memo FROM address_pool
     WHERE user_id = $1 AND asset = $2 AND network = $3 AND status = 'assigned'
     LIMIT 1`,
    [userId, asset, network],
  );
  const row = hit.rows[0];
  return {
    status: row ? "ready" : "preparing",
    address: row ? String(row.address) : null,
    memo: row?.memo ? String(row.memo) : null,
    label: null,
    network,
  };
}

function mapClaim(row: {
  id: number | string;
  user_id: number | string;
  email?: string;
  asset: string;
  network: string;
  amount: string;
  reference: string;
  status: string;
  created_at: Date | string;
}): ClaimRow {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    email: row.email,
    asset: row.asset,
    network: row.network,
    amount: row.amount,
    reference: row.reference,
    status: row.status,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

export async function listClaims(pool: Db, userId: number, status?: string) {
  const rows = await pool.query(
    `SELECT id, user_id, asset, network, amount, reference, status, created_at
     FROM deposit_claims
     WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)
     ORDER BY id DESC LIMIT 20`,
    [userId, status ?? null],
  );
  return rows.rows.map((row) => mapClaim(row));
}

export async function createClaim(
  pool: Db,
  userId: number,
  input: { asset: string; network: string; amount: string; reference: string },
) {
  await assertRealRails(pool, userId);
  assertLiveServicesEnabled();
  const asset = input.asset.trim().toUpperCase();
  const spec = ASSET_NETWORKS[asset];
  if (!spec || asset === "XAU") throw new PlatformError("VALIDATION");
  const network = canonicalNetwork(asset, input.network);
  const reference = normalizeReference(input.reference);
  let gross: bigint;
  try {
    gross = parseScaled(input.amount.trim(), spec.decimals);
  } catch {
    throw new PlatformError("VALIDATION");
  }
  if (gross <= 0n) throw new PlatformError("VALIDATION");
  const amount = money(gross, spec.decimals);
  const taken = await pool.query(
    `SELECT 1 FROM manual_deposits WHERE asset = $1 AND lower(reference) = lower($2) LIMIT 1`,
    [asset, reference],
  );
  if (taken.rowCount) throw new PlatformError("DUPLICATE_REFERENCE", 409);
  const existing = await pool.query(
    `SELECT id, user_id, asset, network, amount, reference, status, created_at
     FROM deposit_claims
     WHERE user_id = $1 AND asset = $2 AND lower(reference) = lower($3) AND status = 'pending'
     LIMIT 1`,
    [userId, asset, reference],
  );
  if (existing.rowCount) return { claim: mapClaim(existing.rows[0]), existing: true };
  try {
    const inserted = await pool.query(
      `INSERT INTO deposit_claims (user_id, asset, network, amount, reference)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, user_id, asset, network, amount, reference, status, created_at`,
      [userId, asset, network, amount, reference],
    );
    return { claim: mapClaim(inserted.rows[0]), existing: false };
  } catch (err) {
    if (!uniqueViolation(err)) throw err;
    const again = await pool.query(
      `SELECT id, user_id, asset, network, amount, reference, status, created_at
       FROM deposit_claims
       WHERE user_id = $1 AND asset = $2 AND lower(reference) = lower($3) AND status = 'pending'
       LIMIT 1`,
      [userId, asset, reference],
    );
    if (!again.rowCount) throw err;
    return { claim: mapClaim(again.rows[0]), existing: true };
  }
}

export async function preview(
  pool: Db,
  staff: Staff,
  input: { userId: number; asset: string; network: string; amount?: string },
) {
  await assertCreditor(pool, staff);
  const customer = await realCustomer(pool, input.userId);
  const asset = input.asset.trim().toUpperCase();
  const network = canonicalNetwork(asset, input.network);
  const who = await pool.query(`SELECT email FROM users WHERE id = $1`, [customer.id]);
  const claims = await pool.query(
    `SELECT id, user_id, asset, network, amount, reference, status, created_at
     FROM deposit_claims
     WHERE user_id = $1 AND status = 'pending' AND asset = $2 AND network = $3
     ORDER BY id DESC LIMIT 8`,
    [customer.id, asset, network],
  );
  const address = await assigned(pool, customer.id, asset, network);
  const quote = input.amount?.trim() ? await quoteCredit(pool, asset, input.amount.trim()) : null;
  return {
    customer: { id: customer.id, email: String(who.rows[0].email) },
    asset,
    network,
    address,
    claims: claims.rows.map((row) => mapClaim(row)),
    quote: quote
      ? {
          gross: quote.grossText,
          fee: quote.feeText,
          net: quote.netText,
          notionalUsd: quote.notionalUsd,
          flag: quote.flag,
          flagUsd: quote.flagUsd,
          minUsd: quote.minUsd,
          maxUsd: quote.maxUsd,
          feeUsd: quote.feeUsd,
        }
      : null,
  };
}

async function writeNotice(client: PoolClient, userId: number, title: string, body: string) {
  const codeRow = await client.query(`SELECT phishing_code FROM users WHERE id = $1`, [userId]);
  const code = (codeRow.rows[0]?.phishing_code as string | null) ?? null;
  const stamped = code ? `${body}\n防钓鱼码 ${code}` : body;
  await client.query(
    `INSERT INTO notification_outbox (id, user_id, channel, title, body, phishing_code, provider, status)
     VALUES ($1,$2,'inapp',$3,$4,$5,'inapp','mock_sent')`,
    [randomUUID(), userId, title, stamped, code],
  );
}

export async function credit(
  pool: Db,
  staff: Staff,
  input: {
    userId: number;
    asset: string;
    network: string;
    amount: string;
    reference: string;
    receivedAt: string;
    note?: string | null;
    screenshotUrl?: string | null;
    totp?: string;
    confirm?: boolean;
    claimId?: number | null;
    txHash?: string | null;
  },
) {
  await assertCreditor(pool, staff);
  if (input.confirm !== true) throw new PlatformError("CONFIRM_REQUIRED");
  const asset = input.asset.trim().toUpperCase();
  const network = canonicalNetwork(asset, input.network);
  const reference = normalizeReference(input.reference);
  const received = new Date(input.receivedAt);
  if (Number.isNaN(received.getTime())) throw new PlatformError("VALIDATION");
  if (received.getTime() > Date.now() + 5 * 60_000) throw new PlatformError("VALIDATION");
  const txHash = input.txHash?.trim() ? input.txHash.trim() : null;
  if (txHash && (txHash.length < 4 || txHash.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(txHash))) {
    throw new PlatformError("VALIDATION");
  }
  const noteText = input.note?.trim() ? input.note.trim() : "";
  const note = [noteText, txHash ? `tx ${txHash}` : ""].filter(Boolean).join("\n").slice(0, 500) || null;
  const shot = input.screenshotUrl?.trim() ? input.screenshotUrl.trim() : null;
  if (shot && (!/^https?:\/\//i.test(shot) || shot.length > 400)) throw new PlatformError("VALIDATION");
  const customer = await realCustomer(pool, input.userId);
  const quoted = await quoteCredit(pool, asset, input.amount.trim());
  await requireFreshTotp(pool, staff.id, input.totp);
  const ref = journalRef(asset, reference);
  try {
    return await withTx(pool, async (client) => {
      const dup = await client.query(
        `SELECT id FROM manual_deposits WHERE asset = $1 AND lower(reference) = lower($2) LIMIT 1`,
        [asset, reference],
      );
      if (dup.rowCount) throw new PlatformError("DUPLICATE_REFERENCE", 409);
      const transferId = await deposit(client, customer, asset, quoted.net, { ref, actorUserId: staff.id });
      let claimId: number | null = input.claimId ?? null;
      if (claimId) {
        const claim = await client.query(
          `SELECT id FROM deposit_claims
           WHERE id = $1 AND user_id = $2 AND asset = $3 AND status = 'pending' AND lower(reference) = lower($4)`,
          [claimId, customer.id, asset, reference],
        );
        if (!claim.rowCount) throw new PlatformError("VALIDATION");
      } else {
        const claim = await client.query(
          `SELECT id FROM deposit_claims
           WHERE user_id = $1 AND asset = $2 AND status = 'pending' AND lower(reference) = lower($3)
           ORDER BY id DESC LIMIT 1`,
          [customer.id, asset, reference],
        );
        claimId = claim.rowCount ? Number(claim.rows[0].id) : null;
      }
      const inserted = await client.query(
        `INSERT INTO manual_deposits (
           user_id, asset, network, gross_amount, fee_amount, net_amount, decimals, reference,
           received_at, note, screenshot_url, actor_id, transfer_id, claim_id, flagged
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id`,
        [
          customer.id,
          asset,
          network,
          quoted.gross.toString(),
          quoted.fee.toString(),
          quoted.net.toString(),
          quoted.decimals,
          reference,
          received.toISOString(),
          note,
          shot,
          staff.id,
          transferId,
          claimId,
          quoted.flag,
        ],
      );
      const id = Number(inserted.rows[0].id);
      if (claimId) {
        await client.query(
          `UPDATE deposit_claims SET status = 'credited', manual_deposit_id = $2 WHERE id = $1 AND status = 'pending'`,
          [claimId, id],
        );
      }
      await client.query(
        `INSERT INTO deposit_records (id, user_id, asset, network, amount, status, txid, bank_reference)
         VALUES ($1,$2,$3,$4,$5,'credited',$6,$7)`,
        [`manual-${id}`, customer.id, asset, network, quoted.netText, txHash ?? reference, reference],
      );
      await client.query(`INSERT INTO security_events (user_id, kind, detail) VALUES ($1,'manual_deposit',$2)`, [
        staff.id,
        `credit #${id} customer ${customer.id} ${asset} ${network} gross ${quoted.grossText} fee ${quoted.feeText} net ${quoted.netText} ref ${reference} transfer ${transferId}`,
      ]);
      await writeNotice(
        client,
        customer.id,
        "MERIDEX · 资金 · 入金到账",
        `${asset} ${quoted.netText} 已记入余额。参考号 ${reference}。\n${asset} ${quoted.netText} credited. Reference ${reference}.`,
      );
      if (quoted.flag) {
        const rule = await client.query(`SELECT enabled FROM surv_rules WHERE id = 'large_manual_deposit'`);
        if (rule.rows[0]?.enabled !== false) {
          await client.query(
            `INSERT INTO surv_alerts (id, rule_id, user_id, symbol, severity, demo, detail)
             VALUES ($1,'large_manual_deposit',$2,$3,'high',false,$4)`,
            [
              randomUUID(),
              customer.id,
              asset,
              `手工入账 ${quoted.grossText} ${asset}（约 $${quoted.notionalUsd}）参考号 ${reference}，操作 ${staff.email}`,
            ],
          );
        }
      }
      return {
        id,
        transferId,
        asset,
        network,
        reference,
        gross: quoted.grossText,
        fee: quoted.feeText,
        net: quoted.netText,
        flagged: quoted.flag,
        txHash,
      };
    });
  } catch (err) {
    if (err instanceof PlatformError) throw err;
    if (uniqueViolation(err)) throw new PlatformError("DUPLICATE_REFERENCE", 409);
    if (err instanceof LedgerError) throw new PlatformError(err.code === "INSUFFICIENT_BALANCE" ? "INSUFFICIENT_FUNDS" : "VALIDATION");
    throw err;
  }
}

function mapCredit(row: Record<string, unknown>) {
  const decimals = Number(row.decimals);
  const gross = BigInt(String(row.gross_amount));
  const fee = BigInt(String(row.fee_amount));
  const net = BigInt(String(row.net_amount));
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    email: String(row.email),
    asset: String(row.asset),
    network: String(row.network),
    gross: money(gross, decimals),
    fee: money(fee, decimals),
    net: money(net, decimals),
    reference: String(row.reference),
    receivedAt: row.received_at instanceof Date ? row.received_at.toISOString() : String(row.received_at),
    note: row.note ? String(row.note) : null,
    screenshotUrl: row.screenshot_url ? String(row.screenshot_url) : null,
    actor: String(row.actor_email),
    flagged: Boolean(row.flagged),
    reversedAt: row.reversed_at ? (row.reversed_at instanceof Date ? row.reversed_at.toISOString() : String(row.reversed_at)) : null,
    reverseReason: row.reverse_reason ? String(row.reverse_reason) : null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

const LIST_SQL = `
  SELECT m.*, u.email, a.email AS actor_email
  FROM manual_deposits m
  JOIN users u ON u.id = m.user_id
  JOIN users a ON a.id = m.actor_id
  WHERE ($1 = '' OR u.email ILIKE $2 OR m.reference ILIKE $2 OR m.asset ILIKE $2 OR m.id::text = $1)
`;

export async function listCredits(pool: Db, staff: Staff, q: string) {
  await assertCreditor(pool, staff);
  const query = q.trim().slice(0, 120);
  const rows = await pool.query(`${LIST_SQL} ORDER BY m.id DESC LIMIT 80`, [query, `%${query}%`]);
  return rows.rows.map((row) => mapCredit(row));
}

export async function creditsCsv(pool: Db, staff: Staff, q: string) {
  await assertCreditor(pool, staff);
  const query = q.trim().slice(0, 120);
  const rows = await pool.query(`${LIST_SQL} ORDER BY m.id DESC LIMIT 5000`, [query, `%${query}%`]);
  const lines = ["id,created_at,email,asset,network,gross,fee,net,reference,received_at,actor,flagged,reversed_at,reverse_reason"];
  for (const raw of rows.rows) {
    const row = mapCredit(raw);
    const cells = [
      row.id,
      row.createdAt,
      row.email,
      row.asset,
      row.network,
      row.gross,
      row.fee,
      row.net,
      row.reference,
      row.receivedAt,
      row.actor,
      row.flagged ? "yes" : "no",
      row.reversedAt ?? "",
      row.reverseReason ?? "",
    ];
    lines.push(cells.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","));
  }
  return lines.join("\n");
}

export async function reverseCredit(pool: Db, staff: Staff, id: number, reason: string, totp?: string) {
  await assertOwner(pool, staff);
  const why = reason.trim();
  if (why.length < 3 || why.length > 240) throw new PlatformError("VALIDATION");
  if (!Number.isInteger(id) || id <= 0) throw new PlatformError("VALIDATION");
  await requireFreshTotp(pool, staff.id, totp);
  try {
    return await withTx(pool, async (client) => {
      const row = await client.query(`SELECT * FROM manual_deposits WHERE id = $1 FOR UPDATE`, [id]);
      if (!row.rowCount) throw new PlatformError("NOT_FOUND", 404);
      const item = row.rows[0];
      if (item.reversed_at) throw new PlatformError("ALREADY_REVERSED", 409);
      await assertRealRails(pool, Number(item.user_id));
      const customer = await loadCustomer(pool, Number(item.user_id));
      if (!customer) throw new PlatformError("KYC_REQUIRED", 403);
      const net = BigInt(String(item.net_amount));
      const ref = `reverse:${journalRef(String(item.asset), String(item.reference))}`;
      const transferId = await depositReversal(client, customer, String(item.asset), net, ref, staff.id);
      await client.query(
        `UPDATE manual_deposits
         SET reversed_at = now(), reverse_transfer_id = $2, reverse_actor_id = $3, reverse_reason = $4
         WHERE id = $1`,
        [id, transferId, staff.id, why],
      );
      const decimals = Number(item.decimals);
      const netText = money(net, decimals);
      await client.query(`INSERT INTO security_events (user_id, kind, detail) VALUES ($1,'manual_deposit_reverse',$2)`, [
        staff.id,
        `reverse #${id} customer ${item.user_id} ${item.asset} net ${netText} ref ${item.reference} reason ${why} transfer ${transferId}`,
      ]);
      await writeNotice(
        client,
        Number(item.user_id),
        "MERIDEX · 资金 · 入账冲回",
        `${item.asset} ${netText} 入账已冲回。参考号 ${item.reference}。\n${item.asset} ${netText} credit was reversed. Reference ${item.reference}.`,
      );
      return { id, transferId, asset: String(item.asset), net: netText, reference: String(item.reference) };
    });
  } catch (err) {
    if (err instanceof PlatformError) throw err;
    if (err instanceof LedgerError && err.code === "INSUFFICIENT_BALANCE") throw new PlatformError("INSUFFICIENT_FUNDS");
    if (err instanceof LedgerError) throw new PlatformError("VALIDATION");
    throw err;
  }
}

export async function meta(pool: Db) {
  const numbers = await loadNumbers(pool);
  return {
    assets: Object.entries(ASSET_NETWORKS).map(([id, spec]) => ({ id, networks: spec.networks, decimals: spec.decimals })),
    minUsd: numbers["deposit.minUsd"] ?? 0,
    maxUsd: numbers["deposit.maxUsd"] ?? 0,
    feeUsd: numbers["deposit.feeUsd"] ?? 0,
    flagUsd: numbers["deposit.flagUsd"] ?? 0,
  };
}
