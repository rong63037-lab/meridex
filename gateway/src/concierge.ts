import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import type { Db } from "./db.js";
import { PlatformError } from "./errors.js";
import { addressHash, canonicalPair, depositGuidePath } from "./addresses.js";
import { assignNext, customerAddresses, linkedPoolAddresses, writePoolAuditSafe } from "./pool.js";

const ETH = /\b0x[a-fA-F0-9]{40}\b/g;
const BTC = /\b(?:(?:bc1|tb1)[ac-hj-np-z0-9]{20,}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/gi;
const TRON = /\bT[1-9A-HJ-NP-Za-km-z]{33}\b/g;
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;
const SWIFT = /\b[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/g;
const LONG_DIGITS = /\d{10,}/g;
const GROUPED = /\b\d{2,4}(?:[ -]\d{2,4}){2,}\b/g;
const TX = /\b(?:0x[a-fA-F0-9]{64}|[a-fA-F0-9]{64})\b/g;

export type LeakKind = "crypto" | "iban" | "swift" | "account";

function parkTx(text: string): { text: string; held: string[] } {
  const held: string[] = [];
  const parked = text.replace(TX, (match) => {
    held.push(match);
    return ` `;
  });
  return { text: parked, held };
}

export function paymentTokens(text: string): { kind: LeakKind; value: string }[] {
  const { text: body } = parkTx(text);
  const found: { kind: LeakKind; value: string }[] = [];
  const take = (re: RegExp, kind: LeakKind) => {
    for (const match of body.match(re) ?? []) found.push({ kind, value: match });
  };
  take(ETH, "crypto");
  take(BTC, "crypto");
  take(TRON, "crypto");
  take(IBAN, "iban");
  take(LONG_DIGITS, "account");
  for (const group of body.match(GROUPED) ?? []) {
    if (group.replace(/\D/g, "").length >= 10) found.push({ kind: "account", value: group });
  }
  for (const token of body.match(SWIFT) ?? []) {
    if ((token.length === 8 || token.length === 11) && (/\d/.test(token) || token.endsWith("XXX"))) {
      found.push({ kind: "swift", value: token });
    }
  }
  return found;
}

export function paymentLeak(text: string): LeakKind | null {
  return paymentTokens(text)[0]?.kind ?? null;
}

export function maskPayments(text: string): string {
  const held: string[] = [];
  const parked = text.replace(TX, (match) => {
    held.push(match);
    return `\u0000${held.length - 1}\u0000`;
  });
  const masked = parked
    .replace(ETH, (value) => maskPiece(value))
    .replace(BTC, (value) => maskPiece(value))
    .replace(TRON, (value) => maskPiece(value))
    .replace(IBAN, (value) => maskPiece(value))
    .replace(LONG_DIGITS, (value) => maskPiece(value))
    .replace(GROUPED, (group) => (group.replace(/\D/g, "").length >= 10 ? maskPiece(group) : group))
    .replace(SWIFT, (token) => ((token.length === 8 || token.length === 11) && (/\d/.test(token) || token.endsWith("XXX")) ? maskPiece(token) : token));
  return masked.replace(/\u0000(\d+)\u0000/g, (_m, index) => held[Number(index)] ?? "");
}

function maskPiece(value: string): string {
  if (value.length <= 8) return "••••";
  if (value.startsWith("0x") || value.toLowerCase().startsWith("bc1") || value.toLowerCase().startsWith("tb1") || value.startsWith("T")) {
    return `${value.slice(0, 6)}…${value.slice(-4)}`;
  }
  return `••••${value.slice(-4)}`;
}

function norm(value: string): string {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("0x") || lower.startsWith("bc1") || lower.startsWith("tb1")) return lower;
  return trimmed.replace(/\s+/g, "");
}

function addLinked(linked: Set<string>, value: string | null | undefined) {
  if (!value) return;
  linked.add(norm(value));
  linked.add(value.trim());
  const digits = value.replace(/\D/g, "");
  if (digits.length >= 10) linked.add(digits);
}

export async function screenStaffMessage(pool: Db, customerId: number, body: string): Promise<{ ok: true } | { ok: false; kind: LeakKind }> {
  const tokens = paymentTokens(body);
  if (!tokens.length) return { ok: true };
  const linked = new Set<string>();
  for (const address of await linkedPoolAddresses(pool, customerId)) addLinked(linked, address);
  const profile = await pool.query(`SELECT reference_code, bank_account FROM deposit_profiles WHERE user_id = $1`, [customerId]);
  if (profile.rowCount) {
    addLinked(linked, String(profile.rows[0].reference_code));
    addLinked(linked, String(profile.rows[0].bank_account));
  }
  const fund = await pool.query(`SELECT fund_id FROM users WHERE id = $1`, [customerId]);
  if (fund.rowCount) addLinked(linked, String(fund.rows[0].fund_id));
  const records = await pool.query(
    `SELECT txid, source_address, bank_reference FROM deposit_records WHERE user_id = $1`,
    [customerId],
  );
  for (const row of records.rows) {
    addLinked(linked, row.txid as string | null);
    addLinked(linked, row.source_address as string | null);
    addLinked(linked, row.bank_reference as string | null);
  }
  const chats = await pool.query(`SELECT body FROM chat_messages WHERE user_id = $1 AND staff = false`, [customerId]);
  for (const row of chats.rows) {
    for (const token of paymentTokens(String(row.body))) addLinked(linked, token.value);
  }
  for (const token of tokens) {
    const digits = token.value.replace(/\D/g, "");
    const known = linked.has(norm(token.value)) || linked.has(token.value) || (digits.length >= 10 && linked.has(digits));
    if (!known) return { ok: false, kind: token.kind };
  }
  return { ok: true };
}

export async function recordPaymentBlock(pool: Db, staffId: number, customerId: number, kind: LeakKind, body: string) {
  const redacted = maskPayments(body).slice(0, 180);
  await pool.query(`INSERT INTO security_events (user_id, kind, detail) VALUES ($1,'payment_share',$2)`, [
    staffId,
    `${kind} blocked for user ${customerId}: ${redacted}`,
  ]);
  await pool.query(
    `INSERT INTO surv_alerts (id, rule_id, user_id, severity, demo, detail)
     VALUES ($1,'payment_share',$2,'high',true,$3)`,
    [randomUUID(), staffId, `坐席消息含未关联的收款信息（${kind}），已拦截。${redacted}`],
  );
}

async function ensureBankProfile(pool: Db, userId: number) {
  const found = await pool.query(`SELECT reference_code, bank_name, bank_account FROM deposit_profiles WHERE user_id = $1`, [userId]);
  if (found.rowCount) return found.rows[0];
  const reference = `MX${String(userId).padStart(8, "0")}`;
  const bankAccount = `900${String(userId).padStart(12, "0")}`;
  await pool.query(
    `INSERT INTO deposit_profiles (user_id, reference_code, bank_name, bank_account, crypto_asset, crypto_address)
     VALUES ($1,$2,'MERIDEX SANDBOX BANK',$3,'USDT',$4)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, reference, bankAccount, `unset-${userId}`],
  );
  const row = await pool.query(`SELECT reference_code, bank_name, bank_account FROM deposit_profiles WHERE user_id = $1`, [userId]);
  return row.rows[0];
}

export async function depositInstructions(pool: Db, userId: number) {
  const profile = await ensureBankProfile(pool, userId);
  const manager = await pool.query(
    `SELECT m.email FROM users u JOIN users m ON m.id = u.account_manager_id WHERE u.id = $1`,
    [userId],
  );
  const addresses = await customerAddresses(pool, userId);
  const decorated = [];
  for (const item of addresses) {
    decorated.push({
      ...item,
      qrDataUrl: item.address ? await QRCode.toDataURL(item.address, { margin: 1, width: 180 }) : null,
    });
  }
  const fund = await pool.query(`SELECT fund_id FROM users WHERE id = $1`, [userId]);
  const fundId = String(fund.rows[0]?.fund_id ?? profile.reference_code);
  return {
    referenceCode: fundId,
    fundId,
    legacyReference: profile.reference_code as string,
    bankName: profile.bank_name as string,
    bankAccount: profile.bank_account as string,
    guidePath: "/funds/deposit",
    bankQrDataUrl: await QRCode.toDataURL(fundId, { margin: 1, width: 220 }),
    nameMatch: true,
    addresses: decorated,
    manager: manager.rowCount ? { email: manager.rows[0].email as string } : null,
  };
}

const cardHits = new Map<number, number[]>();

export function takeCardSlot(staffId: number, limit = 5): boolean {
  const now = Date.now();
  const window = (cardHits.get(staffId) ?? []).filter((at) => now - at < 60_000);
  if (window.length >= limit) {
    cardHits.set(staffId, window);
    return false;
  }
  window.push(now);
  cardHits.set(staffId, window);
  return true;
}

export async function sendDepositCard(
  pool: Db,
  staffId: number,
  customerId: number,
  asset: string,
  network: string,
  ip: string,
) {
  const pair = canonicalPair(asset, network);
  if (!pair) throw new PlatformError("VALIDATION");
  if (!takeCardSlot(staffId)) throw new PlatformError("RATE_LIMITED", 429);
  const assigned = await assignNext(pool, customerId, pair.asset, pair.network);
  if (assigned.status !== "ready" || !assigned.address) throw new PlatformError("ADDRESS_PREPARING", 409);
  const qrDataUrl = await QRCode.toDataURL(assigned.address, { margin: 1, width: 180 });
  const card = {
    verified: true,
    issuer: "MERIDEX",
    kind: "deposit_card",
    asset: assigned.asset,
    network: assigned.network,
    address: assigned.address,
    memo: assigned.memo,
    min: assigned.min,
    qrDataUrl,
    warning: assigned.warning,
    hint: assigned.hint,
    guidePath: depositGuidePath(assigned.asset, assigned.network),
    addressHash: assigned.addressHash,
  };
  await pool.query(
    `INSERT INTO chat_messages (user_id, author_id, body, staff, topic, kind, card)
     VALUES ($1,$2,$3,true,'deposit','deposit_card',$4::jsonb)`,
    [customerId, staffId, "Verified deposit address card", JSON.stringify(card)],
  );
  await pool.query(`INSERT INTO security_events (user_id, kind, detail) VALUES ($1,'deposit_card',$2)`, [
    staffId,
    `customer ${customerId} ${pair.asset} ${pair.network} ${assigned.addressHash}`,
  ]);
  await writePoolAuditSafe(pool, {
    actorId: staffId,
    action: "deposit_card",
    ip,
    customerId,
    asset: pair.asset,
    network: pair.network,
    newHash: assigned.addressHash,
    detail: "verified card",
  });
  return recentChat(pool, customerId);
}

export async function sendStatusCard(pool: Db, staffId: number, customerId: number, depositId: string) {
  if (!takeCardSlot(staffId)) throw new PlatformError("RATE_LIMITED", 429);
  const row = await pool.query(
    `SELECT id, asset, network, amount, status, txid, created_at FROM deposit_records WHERE id = $1 AND user_id = $2`,
    [depositId, customerId],
  );
  if (!row.rowCount) throw new PlatformError("NOT_FOUND", 404);
  const item = row.rows[0];
  const card = {
    verified: true,
    issuer: "MERIDEX",
    kind: "deposit_status",
    depositId: item.id,
    asset: item.asset,
    network: item.network,
    amount: item.amount,
    status: item.status,
    txid: item.txid,
    guidePath: item.network ? depositGuidePath(String(item.asset), String(item.network)) : "/funds/deposit",
  };
  await pool.query(
    `INSERT INTO chat_messages (user_id, author_id, body, staff, topic, kind, card)
     VALUES ($1,$2,$3,true,'deposit','deposit_status',$4::jsonb)`,
    [customerId, staffId, "Verified deposit status", JSON.stringify(card)],
  );
  return recentChat(pool, customerId);
}

export async function recentChat(pool: Db, userId: number) {
  const rows = await pool.query(
    `SELECT c.id, c.body, c.staff, c.created_at, c.kind, c.card, u.email AS author_email
     FROM chat_messages c LEFT JOIN users u ON u.id = c.author_id
     WHERE c.user_id = $1 ORDER BY c.id DESC LIMIT 30`,
    [userId],
  );
  return rows.rows.reverse().map((row) => ({
    ...row,
    masked: row.kind === "text" ? maskPayments(String(row.body)) : row.body,
  }));
}

export async function listDeposits(pool: Db, userId: number) {
  const rows = await pool.query(
    `SELECT id, asset, network, amount, status, confirmations, required_confirmations, txid, created_at
     FROM deposit_records WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30`,
    [userId],
  );
  return rows.rows;
}

export async function lookupDeposits(pool: Db, q: string) {
  const query = q.trim().slice(0, 120);
  if (query.length < 2) throw new PlatformError("VALIDATION");
  const like = `%${query}%`;
  const rows = await pool.query(
    `SELECT d.id, d.asset, d.network, d.amount, d.status, d.confirmations, d.txid, d.created_at, u.email, u.id AS user_id
     FROM deposit_records d JOIN users u ON u.id = d.user_id
     WHERE d.id = $1 OR d.txid ILIKE $2 OR d.source_address ILIKE $2 OR d.bank_reference ILIKE $2
        OR u.email ILIKE $2 OR u.fund_id ILIKE $2
     ORDER BY d.created_at DESC LIMIT 20`,
    [query, like],
  );
  const attributed = await pool.query(
    `SELECT h.asset, h.network, h.active, h.address_hash, u.email, u.id AS user_id
     FROM address_history h JOIN users u ON u.id = h.user_id
     WHERE h.address_hash = $1 OR lower(h.address) = lower($2)
     ORDER BY h.id DESC LIMIT 5`,
    [addressHash(query), query],
  );
  return { deposits: rows.rows, attribution: attributed.rows };
}

export async function recordDeposit(
  pool: Db,
  input: {
    id: string;
    userId: number;
    asset: string;
    network?: string | null;
    amount: string;
    status: "pending" | "confirming" | "credited" | "flagged";
    txid?: string | null;
    sourceAddress?: string | null;
    bankReference?: string | null;
    confirmations?: number;
    required?: number;
  },
) {
  await pool.query(
    `INSERT INTO deposit_records (id, user_id, asset, network, amount, status, confirmations, required_confirmations, txid, source_address, bank_reference)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, confirmations = EXCLUDED.confirmations, txid = COALESCE(EXCLUDED.txid, deposit_records.txid)`,
    [
      input.id,
      input.userId,
      input.asset,
      input.network ?? null,
      input.amount,
      input.status,
      input.confirmations ?? 0,
      input.required ?? 0,
      input.txid ?? null,
      input.sourceAddress ?? null,
      input.bankReference ?? null,
    ],
  );
}

export async function bookCallback(
  pool: Db,
  userId: number,
  input: { when: string; language: string; phone?: string },
) {
  if (!["zh", "en", "ms"].includes(input.language)) throw new PlatformError("VALIDATION");
  const when = input.when.trim().slice(0, 40);
  if (when.length < 4) throw new PlatformError("VALIDATION");
  const phone = (input.phone ?? "").trim().slice(0, 24);
  if (phone && !/^[0-9+() .\-]{6,24}$/.test(phone)) throw new PlatformError("VALIDATION");
  const id = randomUUID();
  await pool.query(
    `INSERT INTO tickets (id, user_id, subject, status, kind, callback_at, callback_lang, callback_phone)
     VALUES ($1,$2,'充值回拨','open','callback',$3,$4,$5)`,
    [id, userId, when, input.language, phone || null],
  );
  await pool.query(
    `INSERT INTO ticket_messages (ticket_id, author_id, body, staff) VALUES ($1,$2,$3,false)`,
    [id, userId, `希望在 ${when} 用 ${input.language} 回拨。${phone ? "电话已留在工单上。" : "未留电话。"}`],
  );
  return { id };
}

export async function conciergeQueues(pool: Db) {
  const depositChats = await pool.query(
    `SELECT c.user_id, u.email, count(*)::int AS n, max(c.created_at) AS last_at
     FROM chat_messages c JOIN users u ON u.id = c.user_id
     WHERE c.topic = 'deposit'
     GROUP BY c.user_id, u.email
     ORDER BY max(c.id) DESC
     LIMIT 40`,
  );
  const callbacks = await pool.query(
    `SELECT t.id, t.status, t.callback_at, t.callback_lang, t.callback_phone, u.email
     FROM tickets t JOIN users u ON u.id = t.user_id
     WHERE t.kind = 'callback'
     ORDER BY t.created_at DESC
     LIMIT 40`,
  );
  const tasks = await pool.query(
    `SELECT a.id, a.kind, a.title, a.status, a.created_at, u.email, m.email AS assignee
     FROM agent_tasks a
     JOIN users u ON u.id = a.user_id
     LEFT JOIN users m ON m.id = a.assignee_id
     WHERE a.status = 'open'
     ORDER BY a.created_at DESC
     LIMIT 40`,
  );
  return { depositChats: depositChats.rows, callbacks: callbacks.rows, tasks: tasks.rows };
}

export async function assignManager(
  pool: Db,
  actorId: number,
  customerEmail: string,
  managerEmail: string,
  vip: boolean,
) {
  const customer = await pool.query(`SELECT id FROM users WHERE email = $1`, [customerEmail.trim()]);
  const manager = await pool.query(`SELECT id, role FROM users WHERE email = $1`, [managerEmail.trim()]);
  if (!customer.rowCount || !manager.rowCount) throw new PlatformError("NOT_FOUND", 404);
  if (!["support", "admin", "ops"].includes(String(manager.rows[0].role))) throw new PlatformError("VALIDATION");
  await pool.query(`UPDATE users SET account_manager_id = $2, vip_desk = $3 WHERE id = $1`, [
    customer.rows[0].id,
    manager.rows[0].id,
    vip,
  ]);
  await pool.query(`INSERT INTO security_events (user_id, kind, detail) VALUES ($1,'account_manager',$2)`, [
    actorId,
    `${customerEmail.trim()} -> ${managerEmail.trim()} vip=${vip}`,
  ]);
  return { ok: true };
}

export async function onDepositCredited(pool: Db, userId: number, asset: string, amountLabel: string) {
  const { enqueueNotice } = await import("./platform.js");
  await enqueueNotice(
    pool,
    userId,
    "inapp",
    "MERIDEX · 资金 · 入金到账",
    `${asset} ${amountLabel} 已记入余额。收款信息只在资金页和经过校验的充值地址卡片里显示。`,
  );
  const fund = await pool.query(`SELECT fund_id FROM users WHERE id = $1`, [userId]);
  const profile = await pool.query(`SELECT reference_code FROM deposit_profiles WHERE user_id = $1`, [userId]);
  const reference = (fund.rows[0]?.fund_id as string | undefined) ?? (profile.rows[0]?.reference_code as string | undefined) ?? null;
  await recordDeposit(pool, {
    id: randomUUID(),
    userId,
    asset,
    network: asset === "USD" ? "Bank" : null,
    amount: amountLabel,
    status: "credited",
    bankReference: reference,
  });
  const manager = await pool.query(`SELECT account_manager_id FROM users WHERE id = $1`, [userId]);
  let assignee = (manager.rows[0]?.account_manager_id as number | null) ?? null;
  if (!assignee) {
    const support = await pool.query(`SELECT id FROM users WHERE role = 'support' ORDER BY id LIMIT 1`);
    assignee = (support.rows[0]?.id as number | undefined) ?? null;
  }
  await pool.query(
    `INSERT INTO agent_tasks (id, user_id, assignee_id, kind, title) VALUES ($1,$2,$3,'deposit_followup',$4)`,
    [randomUUID(), userId, assignee, `${asset} 模拟入金已到账，请跟进客户`],
  );
}
