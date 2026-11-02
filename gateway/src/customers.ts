/** Customer directory and the staff profile. Sensitive reads and writes are audit-logged. Secrets stay out. */
import type { Db } from "./db.js";
import { PlatformError } from "./errors.js";
import { loadCatalog } from "./instruments.js";
import { decideChange, proposeChange } from "./platform.js";
import { requireFreshTotp } from "./pool.js";
import { formatScaled } from "./units.js";
import { usdNotional } from "./withdrawals.js";

type Staff = { id: number; email: string; role: string };

const FUND_RE = /^MXF-[0-9A-F]{8}$/;

function decimalsOf(asset: string): number {
  if (asset === "USD" || asset === "USDT") return 6;
  if (asset === "XAU") return 3;
  const inst = loadCatalog().find((row) => row.base === asset && row.quote === "USD");
  return inst?.qtyDecimals ?? 8;
}

function money(asset: string, amount: bigint): string {
  const decimals = decimalsOf(asset);
  const shown = asset === "USD" || asset === "USDT" ? 2 : decimals;
  return formatScaled(amount, decimals, shown);
}

function csvCell(value: unknown): string {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

async function audit(pool: Db, staffId: number, kind: string, detail: string) {
  await pool.query(`INSERT INTO security_events (user_id, kind, detail) VALUES ($1,$2,$3)`, [
    staffId,
    kind,
    detail.slice(0, 400),
  ]);
}

async function assertOwner(pool: Db, staffId: number) {
  const row = await pool.query(`SELECT address_pool_owner FROM users WHERE id = $1`, [staffId]);
  if (!row.rows[0]?.address_pool_owner) throw new PlatformError("FORBIDDEN", 403);
}

export async function resolveCustomerId(pool: Db, key: string): Promise<number> {
  const raw = key.trim();
  if (FUND_RE.test(raw.toUpperCase())) {
    const row = await pool.query(`SELECT id FROM users WHERE fund_id = $1`, [raw.toUpperCase()]);
    if (!row.rowCount) throw new PlatformError("NOT_FOUND", 404);
    return Number(row.rows[0].id);
  }
  if (/^\d+$/.test(raw)) {
    const row = await pool.query(`SELECT id FROM users WHERE id = $1`, [Number(raw)]);
    if (!row.rowCount) throw new PlatformError("NOT_FOUND", 404);
    return Number(row.rows[0].id);
  }
  throw new PlatformError("NOT_FOUND", 404);
}

export async function searchDirectory(pool: Db, q: string) {
  const query = q.trim().slice(0, 120);
  const rows = await pool.query(
    `SELECT u.id, u.email, u.fund_id, u.display_name, u.frozen, u.is_internal_test, u.address_pool_owner,
            u.role, u.created_at, k.status AS kyc_status, k.residence_country
     FROM users u
     LEFT JOIN kyc_profiles k ON k.user_id = u.id
     WHERE u.role = 'customer'
       AND ($1 = '' OR u.email ILIKE $2 OR u.fund_id ILIKE $2 OR coalesce(u.display_name, '') ILIKE $2
            OR u.id::text = $1
            OR EXISTS (SELECT 1 FROM tickets t WHERE t.user_id = u.id AND coalesce(t.callback_phone, '') ILIKE $2))
     ORDER BY u.id DESC
     LIMIT 40`,
    [query, `%${query}%`],
  );
  return rows.rows.map((row) => ({
    id: Number(row.id),
    email: String(row.email),
    fundId: String(row.fund_id),
    name: row.display_name ? String(row.display_name) : "",
    frozen: Boolean(row.frozen),
    internalTest: Boolean(row.is_internal_test),
    staff: row.role !== "customer" || Boolean(row.address_pool_owner),
    kycStatus: (row.kyc_status as string | null) ?? "none",
    country: (row.residence_country as string | null) ?? "",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }));
}

type LedgerTotals = { asset: string; deposited: bigint; withdrawn: bigint };

async function ledgerTotals(pool: Db, userId: number): Promise<LedgerTotals[]> {
  const rows = await pool.query(
    `SELECT p.asset,
            COALESCE(SUM(CASE
              WHEN j.kind IN ('deposit_usd', 'vault_in') AND p.side = 'credit' THEN p.amount
              WHEN j.kind = 'deposit_reversal' AND p.side = 'debit' THEN -p.amount
              ELSE 0 END), 0)::text AS deposited,
            COALESCE(SUM(CASE
              WHEN j.kind IN ('withdraw_usd', 'vault_out') AND p.side = 'debit' THEN p.amount
              ELSE 0 END), 0)::text AS withdrawn
     FROM postings p
     JOIN journal_entries j ON j.id = p.entry_id
     JOIN accounts a ON a.id = p.account_id
     WHERE a.customer_id = $1
     GROUP BY p.asset`,
    [userId],
  );
  return rows.rows
    .map((row) => ({
      asset: String(row.asset),
      deposited: BigInt(String(row.deposited)),
      withdrawn: BigInt(String(row.withdrawn)),
    }))
    .filter((row) => row.deposited !== 0n || row.withdrawn !== 0n);
}

function presentTotals(rows: LedgerTotals[]) {
  return rows.map((row) => ({
    asset: row.asset,
    deposited: row.deposited.toString(),
    withdrawn: row.withdrawn.toString(),
    net: (row.deposited - row.withdrawn).toString(),
    depositedText: money(row.asset, row.deposited),
    withdrawnText: money(row.asset, row.withdrawn),
    netText: money(row.asset, row.deposited - row.withdrawn),
  }));
}

type HistoryRow = {
  at: string;
  asset: string;
  network: string;
  amount: string;
  amountRaw: string;
  address: string;
  reference: string;
  txHash: string;
  status: string;
  actor: string;
  reason: string;
};

async function depositHistory(pool: Db, userId: number): Promise<HistoryRow[]> {
  const rows = await pool.query(
    `SELECT j.id, j.created_at, j.kind, j.ref, p.asset, p.amount::text AS amount,
            m.network AS m_network, m.reference AS m_reference, m.note AS m_note,
            rev.reference AS rev_reference, rev.reverse_reason, rev.network AS rev_network,
            actor.email AS actor_email
     FROM journal_entries j
     JOIN postings p ON p.entry_id = j.id
     JOIN accounts a ON a.id = p.account_id
     LEFT JOIN users actor ON actor.id = j.actor_user_id
     LEFT JOIN manual_deposits m ON m.transfer_id = j.transfer_id::text
     LEFT JOIN manual_deposits rev ON rev.reverse_transfer_id = j.transfer_id::text
     WHERE a.customer_id = $1
       AND (
         (j.kind IN ('deposit_usd', 'vault_in') AND p.side = 'credit')
         OR (j.kind = 'deposit_reversal' AND p.side = 'debit')
       )
     ORDER BY j.created_at DESC, j.id DESC
     LIMIT 5000`,
    [userId],
  );
  return rows.rows.map((row) => {
    const asset = String(row.asset);
    const amount = BigInt(String(row.amount));
    const signed = row.kind === "deposit_reversal" ? -amount : amount;
    const note = row.m_note ? String(row.m_note) : "";
    const tx = note.split("\n").map((line) => line.match(/^tx\s+(\S+)/)?.[1] ?? "").find(Boolean) ?? "";
    const reference = String(row.m_reference ?? row.rev_reference ?? row.ref ?? "");
    return {
      at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      asset,
      network: String(row.m_network ?? row.rev_network ?? (asset === "USD" ? "Bank" : "")),
      amount: money(asset, signed),
      amountRaw: signed.toString(),
      address: "",
      reference,
      txHash: tx,
      status: row.kind === "deposit_reversal" ? "reversed" : "credited",
      actor: row.actor_email ? String(row.actor_email) : "",
      reason: row.reverse_reason ? String(row.reverse_reason) : "",
    };
  });
}

async function withdrawalHistory(pool: Db, userId: number): Promise<HistoryRow[]> {
  const queued = await pool.query(
    `SELECT w.id, w.asset, w.network, w.address, w.ledger_amount::text, w.status, w.reason, w.tx_hash,
            w.created_at, w.decided_at, w.sent_at, a.email AS actor
     FROM withdrawal_requests w
     LEFT JOIN users a ON a.id = w.actor_id
     WHERE w.user_id = $1
     ORDER BY w.created_at DESC
     LIMIT 5000`,
    [userId],
  );
  const fromQueue: HistoryRow[] = queued.rows.map((row) => {
    const asset = String(row.asset);
    const amount = BigInt(String(row.ledger_amount));
    const at = row.sent_at ?? row.decided_at ?? row.created_at;
    return {
      at: at instanceof Date ? at.toISOString() : String(at),
      asset,
      network: String(row.network ?? ""),
      amount: money(asset, amount),
      amountRaw: amount.toString(),
      address: String(row.address ?? ""),
      reference: `wd-${row.id}`,
      txHash: String(row.tx_hash ?? ""),
      status: String(row.status),
      actor: String(row.actor ?? ""),
      reason: String(row.reason ?? ""),
    };
  });
  const autos = await pool.query(
    `SELECT j.id, j.created_at, j.ref, p.asset, p.amount::text AS amount, actor.email AS actor_email
     FROM journal_entries j
     JOIN postings p ON p.entry_id = j.id
     JOIN accounts a ON a.id = p.account_id
     LEFT JOIN users actor ON actor.id = j.actor_user_id
     WHERE a.customer_id = $1
       AND j.kind IN ('withdraw_usd', 'vault_out')
       AND p.side = 'debit'
       AND (j.ref IS NULL OR j.ref NOT LIKE 'wd-settle:%')
     ORDER BY j.created_at DESC
     LIMIT 5000`,
    [userId],
  );
  const fromAuto: HistoryRow[] = autos.rows.map((row) => {
    const asset = String(row.asset);
    const amount = BigInt(String(row.amount));
    return {
      at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      asset,
      network: "",
      amount: money(asset, amount),
      amountRaw: amount.toString(),
      address: "",
      reference: String(row.ref ?? ""),
      txHash: "",
      status: "posted",
      actor: row.actor_email ? String(row.actor_email) : "",
      reason: "",
    };
  });
  return [...fromQueue, ...fromAuto].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

function csvOf(rows: HistoryRow[], fundId: string): string {
  const lines = ["fund_id,time,asset,network,amount,amount_raw,address,reference,tx_hash,status,actor,reason"];
  for (const row of rows) {
    lines.push(
      [fundId, row.at, row.asset, row.network, row.amount, row.amountRaw, row.address, row.reference, row.txHash, row.status, row.actor, row.reason]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n");
}

export async function customerProfile(pool: Db, staff: Staff, key: string) {
  const userId = await resolveCustomerId(pool, key);
  const who = await pool.query(
    `SELECT u.id, u.email, u.fund_id, u.display_name, u.role, u.created_at, u.frozen, u.freeze_reason,
            u.disabled, u.is_internal_test, u.address_pool_owner, u.kyc_tier, u.jurisdiction,
            u.referral_code, u.vip_desk, u.totp_enabled,
            k.status AS kyc_status, k.residence_country, k.nationality, k.sanctions_hit, k.reason AS kyc_reason,
            m.email AS manager_email, m.fund_id AS manager_fund_id,
            ref.email AS referrer_email, ref.fund_id AS referrer_fund_id
     FROM users u
     LEFT JOIN kyc_profiles k ON k.user_id = u.id
     LEFT JOIN users m ON m.id = u.account_manager_id
     LEFT JOIN users ref ON ref.id = u.referred_by
     WHERE u.id = $1`,
    [userId],
  );
  if (!who.rowCount) throw new PlatformError("NOT_FOUND", 404);
  const row = who.rows[0];
  const phone = await pool.query(
    `SELECT callback_phone FROM tickets
     WHERE user_id = $1 AND callback_phone IS NOT NULL AND callback_phone <> ''
     ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  const balances = await pool.query(
    `SELECT a.asset, a.bucket, b.amount::text
     FROM accounts a JOIN balances b ON b.account_id = a.id
     WHERE a.customer_id = $1 AND a.bucket IN ('available', 'reserved', 'withdraw_hold', 'margin', 'derivatives')`,
    [userId],
  );
  const byAsset = new Map<string, Record<string, bigint>>();
  for (const item of balances.rows) {
    const asset = String(item.asset);
    const slot = byAsset.get(asset) ?? {};
    slot[String(item.bucket)] = BigInt(String(item.amount));
    byAsset.set(asset, slot);
  }
  let usdSum = 0n;
  let unpriced = false;
  const balanceRows = [...byAsset.entries()].map(([asset, slot]) => {
    const spot = slot.available ?? 0n;
    const reserved = slot.reserved ?? 0n;
    const hold = slot.withdraw_hold ?? 0n;
    const margin = slot.margin ?? 0n;
    const derivatives = slot.derivatives ?? 0n;
    const pieces = [spot, reserved, hold, margin, derivatives];
    let usd = 0n;
    for (const piece of pieces) {
      if (piece === 0n) continue;
      const notion = usdNotional(asset, piece);
      if (notion == null) unpriced = true;
      else usd += notion;
    }
    usdSum += usd;
    return {
      asset,
      spot: spot.toString(),
      spotText: money(asset, spot),
      reserved: reserved.toString(),
      reservedText: money(asset, reserved),
      withdrawHold: hold.toString(),
      withdrawHoldText: money(asset, hold),
      margin: margin.toString(),
      marginText: money(asset, margin),
      derivatives: derivatives.toString(),
      derivativesText: money(asset, derivatives),
      usd: usd.toString(),
      usdText: money("USD", usd),
    };
  });
  const addresses = await pool.query(
    `SELECT asset, network, address, memo FROM address_pool
     WHERE user_id = $1 AND status = 'assigned'
     ORDER BY asset, network`,
    [userId],
  );
  const bank = await pool.query(
    `SELECT reference_code, bank_name, bank_account FROM deposit_profiles WHERE user_id = $1`,
    [userId],
  );
  const orders = await pool.query(
    `SELECT engine_order_id, side, order_type, status, qty_mg::text, price_cents::text, created_at
     FROM user_orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 8`,
    [userId],
  );
  const trades = await pool.query(
    `SELECT id, price_cents::text, qty_mg::text, notional_uusd::text, taker_side, tape_at,
            CASE WHEN buyer_id = $1 THEN 'buy' ELSE 'sell' END AS side
     FROM trades WHERE buyer_id = $1 OR seller_id = $1
     ORDER BY tape_at DESC LIMIT 8`,
    [userId],
  );
  const positions = await pool.query(
    `SELECT id, product, symbol, side, qty::text, entry_px::text, leverage, margin_uusd::text, status
     FROM real_positions WHERE user_id = $1 AND status = 'open' ORDER BY id DESC LIMIT 8`,
    [userId],
  );
  const liveOrders = await pool.query(
    `SELECT id, product, symbol, side, order_type, qty::text, status, created_at
     FROM real_orders WHERE user_id = $1 ORDER BY id DESC LIMIT 8`,
    [userId],
  );
  const logins = await pool.query(
    `SELECT ip, country, user_agent, created_at FROM login_events
     WHERE user_id = $1 ORDER BY id DESC LIMIT 12`,
    [userId],
  );
  const tickets = await pool.query(
    `SELECT id, subject, status, created_at FROM tickets WHERE user_id = $1 ORDER BY created_at DESC LIMIT 8`,
    [userId],
  );
  const notes = await pool.query(
    `SELECT n.id, n.body, n.created_at, u.email AS actor
     FROM staff_notes n JOIN users u ON u.id = n.actor_id
     WHERE n.user_id = $1 ORDER BY n.id DESC LIMIT 40`,
    [userId],
  );
  const alerts = await pool.query(
    `SELECT count(*)::int AS n FROM surv_alerts WHERE user_id = $1 AND status = 'open'`,
    [userId],
  );
  const flags: string[] = [];
  if (row.sanctions_hit) flags.push("sanctions");
  if (row.frozen) flags.push("frozen");
  if (row.disabled) flags.push("disabled");
  if (Number(alerts.rows[0].n) > 0) flags.push("surveillance");
  const deposits = await depositHistory(pool, userId);
  const withdrawals = await withdrawalHistory(pool, userId);
  await audit(pool, staff.id, "customer_view", `view user ${userId} ${row.fund_id}`);
  return {
    customer: {
      id: Number(row.id),
      fundId: String(row.fund_id),
      email: String(row.email),
      name: row.display_name ? String(row.display_name) : "",
      phone: phone.rowCount ? String(phone.rows[0].callback_phone) : "",
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      kycStatus: (row.kyc_status as string | null) ?? "none",
      kycTier: String(row.kyc_tier ?? ""),
      kycReason: (row.kyc_reason as string | null) ?? "",
      country: (row.residence_country as string | null) ?? (row.jurisdiction as string | null) ?? "",
      nationality: (row.nationality as string | null) ?? "",
      riskFlags: flags,
      status: row.frozen ? "frozen" : row.disabled ? "disabled" : "active",
      freezeReason: (row.freeze_reason as string | null) ?? "",
      internalTest: Boolean(row.is_internal_test),
      staff: row.role !== "customer" || Boolean(row.address_pool_owner),
      role: String(row.role),
      totpEnabled: row.totp_enabled !== false,
      manager: row.manager_email ? { email: String(row.manager_email), fundId: String(row.manager_fund_id ?? "") } : null,
      referralCode: (row.referral_code as string | null) ?? "",
      referrer: row.referrer_email ? { email: String(row.referrer_email), fundId: String(row.referrer_fund_id ?? "") } : null,
      vipDesk: Boolean(row.vip_desk),
    },
    balances: balanceRows,
    usdTotal: usdSum.toString(),
    usdTotalText: money("USD", usdSum),
    usdPartial: unpriced,
    totals: presentTotals(await ledgerTotals(pool, userId)),
    deposits,
    withdrawals,
    addresses: addresses.rows.map((item) => ({
      asset: String(item.asset),
      network: String(item.network),
      address: String(item.address),
      memo: item.memo ? String(item.memo) : "",
    })),
    bank: bank.rowCount
      ? {
          name: String(bank.rows[0].bank_name),
          account: String(bank.rows[0].bank_account),
          legacyReference: String(bank.rows[0].reference_code),
        }
      : null,
    orders: orders.rows,
    trades: trades.rows,
    positions: positions.rows,
    liveOrders: liveOrders.rows,
    logins: logins.rows.map((item) => ({
      ip: item.ip ? String(item.ip) : "",
      country: item.country ? String(item.country) : "",
      userAgent: item.user_agent ? String(item.user_agent).slice(0, 180) : "",
      at: item.created_at instanceof Date ? item.created_at.toISOString() : String(item.created_at),
    })),
    tickets: tickets.rows.map((item) => ({
      id: String(item.id),
      subject: String(item.subject),
      status: String(item.status),
      at: item.created_at instanceof Date ? item.created_at.toISOString() : String(item.created_at),
    })),
    notes: notes.rows.map((item) => ({
      id: Number(item.id),
      body: String(item.body),
      actor: String(item.actor),
      at: item.created_at instanceof Date ? item.created_at.toISOString() : String(item.created_at),
    })),
  };
}

export async function customerCsv(pool: Db, staff: Staff, key: string, kind: "deposits" | "withdrawals") {
  const userId = await resolveCustomerId(pool, key);
  const fund = await pool.query(`SELECT fund_id FROM users WHERE id = $1`, [userId]);
  if (!fund.rowCount) throw new PlatformError("NOT_FOUND", 404);
  const fundId = String(fund.rows[0].fund_id);
  const rows = kind === "deposits" ? await depositHistory(pool, userId) : await withdrawalHistory(pool, userId);
  await audit(pool, staff.id, "customer_export", `${kind} user ${userId} ${fundId} rows ${rows.length}`);
  return { filename: `${fundId}-${kind}.csv`, csv: csvOf(rows, fundId) };
}

export async function addStaffNote(pool: Db, staff: Staff, key: string, body: string) {
  const userId = await resolveCustomerId(pool, key);
  const text = body.trim();
  if (text.length < 1 || text.length > 2000) throw new PlatformError("VALIDATION");
  const inserted = await pool.query(
    `INSERT INTO staff_notes (user_id, actor_id, body) VALUES ($1,$2,$3) RETURNING id, created_at`,
    [userId, staff.id, text],
  );
  await audit(pool, staff.id, "customer_note", `note ${inserted.rows[0].id} on user ${userId}`);
  return {
    id: Number(inserted.rows[0].id),
    at: inserted.rows[0].created_at instanceof Date ? inserted.rows[0].created_at.toISOString() : String(inserted.rows[0].created_at),
  };
}

/** Owner authenticator. An admin may approve their own freeze, so this is one step and still a change request. */
export async function freezeCustomer(pool: Db, staff: Staff, key: string, frozen: boolean, reason: string, totp: string | undefined) {
  await assertOwner(pool, staff.id);
  await requireFreshTotp(pool, staff.id, totp);
  const userId = await resolveCustomerId(pool, key);
  const who = await pool.query(`SELECT email, role FROM users WHERE id = $1`, [userId]);
  if (!who.rowCount) throw new PlatformError("NOT_FOUND", 404);
  if (who.rows[0].role !== "customer") throw new PlatformError("VALIDATION");
  const why = reason.trim().slice(0, 180);
  if (frozen && why.length < 3) throw new PlatformError("VALIDATION");
  const proposed = await proposeChange(pool, staff.id, "freeze_user", {
    email: String(who.rows[0].email),
    frozen,
    reason: why,
  });
  return decideChange(pool, staff.id, proposed.id, "approve", why || (frozen ? "freeze" : "unfreeze"));
}
