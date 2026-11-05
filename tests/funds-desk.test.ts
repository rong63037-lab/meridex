/**
 * Funds desk, fund ids, customer profile totals, CSV, and audit rows.
 * Runs against a gateway that is already up and has applied 019_fund_accounts.
 */
import { createRequire } from "node:module";
import { totp } from "../gateway/src/crypto.ts";

const require = createRequire(new URL("../gateway/package.json", import.meta.url));
const { Pool } = require("pg") as {
  Pool: new (cfg: { connectionString: string }) => {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
    connect: () => Promise<{
      query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
      release: () => void;
    }>;
    end: () => Promise<void>;
  };
};

const base = process.env.GATEWAY_URL ?? "http://127.0.0.1:7108";
const dbUrl = process.env.DATABASE_URL ?? "postgres://meridex:<redacted>@127.0.0.1:5432/meridex";
const FOUNDER = { email: "founder@meridexexchange.com", password: "<redacted>", secret: "<redacted>" };
const SUPPORT = { email: "support@meridexexchange.com", password: "<redacted>", secret: "<redacted>" };
const DEMO = { email: "client@meridexexchange.com", password: "<redacted>", secret: "<redacted>" };

type Body = Record<string, unknown>;

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function call(path: string, init: RequestInit = {}, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "x-mock-country": "SG",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
  });
  const text = await res.text();
  let data: Body = {};
  try {
    data = text ? (JSON.parse(text) as Body) : {};
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data, text };
}

async function login(email: string, password: string, secret: string, portal: "customer" | "staff" = "staff") {
  const path = portal === "staff" ? "/api/admin/auth/login" : "/api/auth/login";
  let last = await call(path, { method: "POST", body: JSON.stringify({ email, password, totp: totp(secret) }) });
  for (let i = 0; i < 6 && last.status === 429; i += 1) {
    await sleep(1100);
    last = await call(path, { method: "POST", body: JSON.stringify({ email, password, totp: totp(secret) }) });
  }
  assert(last.status === 200 && typeof last.data.token === "string", `login ${email} ${last.status} ${JSON.stringify(last.data)}`);
  return String(last.data.token);
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

function walkKeys(value: unknown, out: Set<string>) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walkKeys(item, out);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out.add(key);
    walkKeys(child, out);
  }
}

async function main() {
  const pool = new Pool({ connectionString: dbUrl });
  const founder = await login(FOUNDER.email, FOUNDER.password, FOUNDER.secret);
  const support = await login(SUPPORT.email, SUPPORT.password, SUPPORT.secret);
  const demo = await login(DEMO.email, DEMO.password, DEMO.secret, "customer");

  const shape = await pool.query(
    `SELECT count(*)::int AS n, count(DISTINCT fund_id)::int AS distinct_n
     FROM users`,
  );
  assert(Number(shape.rows[0].n) > 0 && Number(shape.rows[0].n) === Number(shape.rows[0].distinct_n), "fund id not unique");
  const bad = await pool.query(
    `SELECT id, fund_id FROM users
     WHERE fund_id IS DISTINCT FROM ('MXF-' || lpad(upper(to_hex(id)), 8, '0'))`,
  );
  assert(bad.rowCount === 0, `fund id backfill ${JSON.stringify(bad.rows.slice(0, 3))}`);

  const email = `fund35.${Date.now()}@meridexexchange.com`;
  const registered = await call("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password: "<redacted>", residenceCountry: "SG" }),
  });
  assert(registered.status === 200 && registered.data.userId, `register ${registered.status} ${JSON.stringify(registered.data)}`);
  const newId = Number(registered.data.userId);
  const created = await pool.query(`SELECT fund_id FROM users WHERE id = $1`, [newId]);
  const expectId = `MXF-${newId.toString(16).toUpperCase().padStart(8, "0")}`;
  assert(created.rows[0].fund_id === expectId, `new fund id ${created.rows[0].fund_id} != ${expectId}`);
  await pool.query(`UPDATE users SET display_name = $2 WHERE id = $1`, [newId, "Fund Thirty Five"]);
  await pool.query(
    `INSERT INTO tickets (id, user_id, subject, status, callback_phone) VALUES ($1,$2,'callback','open',$3)`,
    [`fund35-${newId}`, newId, "+6591230099"],
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let failed = false;
    try {
      await client.query(`UPDATE users SET fund_id = $2 WHERE id = $1`, [newId, created.rows[0].fund_id]);
      const other = await client.query(`SELECT id FROM users WHERE id <> $1 LIMIT 1`, [newId]);
      await client.query(`UPDATE users SET fund_id = $2 WHERE id = $1`, [other.rows[0].id, created.rows[0].fund_id]);
    } catch {
      failed = true;
    }
    assert(failed, "duplicate fund id was accepted");
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }

  const me = await call("/api/me", {}, auth(demo));
  assert(me.status === 200 && /^MXF-[0-9A-F]{8}$/.test(String(me.data.fundId)), `me fund ${JSON.stringify(me.data.fundId)}`);
  const instructions = await call("/api/wallet/deposit-instructions", {}, auth(demo));
  assert(instructions.status === 200 && instructions.data.referenceCode === me.data.fundId, `reference ${instructions.data.referenceCode}`);
  assert(instructions.data.fundId === me.data.fundId, "fundId missing on instructions");

  const byFund = await call(`/api/admin/customers?q=${encodeURIComponent(expectId)}`, {}, auth(founder));
  const byMail = await call(`/api/admin/customers?q=${encodeURIComponent(email)}`, {}, auth(founder));
  const byName = await call(`/api/admin/customers?q=${encodeURIComponent("Fund Thirty Five")}`, {}, auth(founder));
  const byPhone = await call(`/api/admin/customers?q=${encodeURIComponent("91230099")}`, {}, auth(founder));
  for (const [label, res] of [["fund", byFund], ["mail", byMail], ["name", byName], ["phone", byPhone]] as const) {
    const rows = (res.data.customers as { id: number }[]) ?? [];
    assert(res.status === 200 && rows.some((row) => row.id === newId), `${label} search ${res.status} ${JSON.stringify(rows.slice(0, 2))}`);
  }

  const profile = await call(`/api/admin/customers/${newId}`, {}, auth(founder));
  assert(profile.status === 200 && profile.data.customer && (profile.data.customer as { fundId: string }).fundId === expectId, `profile ${profile.status}`);
  const keys = new Set<string>();
  walkKeys(profile.data, keys);
  for (const secret of ["password", "password_hash", "totp_secret", "totpSecret", "recovery", "secret"]) {
    assert(!keys.has(secret), `profile leaked ${secret}`);
  }
  const viewed = await pool.query(
    `SELECT 1 FROM security_events WHERE kind = 'customer_view' AND detail LIKE $1 ORDER BY id DESC LIMIT 1`,
    [`%user ${newId}%`],
  );
  assert(viewed.rowCount === 1, "customer_view missing");

  const customerToken = await call("/api/admin/customers", {}, auth(demo));
  assert(customerToken.status === 403, `customer directory ${customerToken.status}`);

  const demoMe = me.data.fundId as string;
  const demoId = Number(me.data.id);
  const before = await pool.query(
    `SELECT COALESCE(SUM(CASE
        WHEN j.kind IN ('deposit_usd','vault_in') AND p.side = 'credit' THEN p.amount
        WHEN j.kind = 'deposit_reversal' AND p.side = 'debit' THEN -p.amount
        ELSE 0 END),0)::text AS deposited
     FROM postings p
     JOIN journal_entries j ON j.id = p.entry_id
     JOIN accounts a ON a.id = p.account_id
     WHERE a.customer_id = $1 AND p.asset = 'USD'`,
    [demoId],
  );
  const reference = `run35${Date.now()}`;
  const claim = await call("/api/wallet/deposit-claims", {
    method: "POST",
    body: JSON.stringify({ asset: "USD", network: "Bank", amount: "12.50", reference }),
  }, auth(demo));
  assert(claim.status === 200 && claim.data.claim, `claim ${claim.status} ${JSON.stringify(claim.data)}`);
  const claimId = Number((claim.data.claim as { id: number }).id);
  const queued = await call(`/api/admin/funds/deposits?status=pending&q=${encodeURIComponent(demoMe)}`, {}, auth(founder));
  assert(queued.status === 200 && ((queued.data.deposits as { id: number }[]) ?? []).some((row) => row.id === claimId), "claim not on funds queue");
  const bare = await call("/api/admin/manual-deposits", {
    method: "POST",
    body: JSON.stringify({
      userId: demoId,
      asset: "USD",
      network: "Bank",
      amount: "12.50",
      reference,
      receivedAt: new Date().toISOString(),
      confirm: true,
      claimId,
    }),
  }, auth(founder));
  assert(bare.status === 401 && bare.data.error === "TOTP_REQUIRED", `empty totp ${bare.status} ${bare.data.error}`);
  const credited = await call("/api/admin/manual-deposits", {
    method: "POST",
    body: JSON.stringify({
      userId: demoId,
      asset: "USD",
      network: "Bank",
      amount: "12.50",
      reference,
      receivedAt: new Date().toISOString(),
      confirm: true,
      claimId,
      totp: totp(FOUNDER.secret),
      txHash: "0xrun35abc123",
    }),
  }, auth(founder));
  assert(credited.status === 200, `credit ${credited.status} ${JSON.stringify(credited.data)}`);
  const gone = await call(`/api/admin/funds/deposits?status=pending&q=${encodeURIComponent(reference)}`, {}, auth(founder));
  assert(!((gone.data.deposits as { id: number }[]) ?? []).some((row) => row.id === claimId), "credited claim still pending");

  const demoProfile = await call(`/api/admin/customers/${demoId}`, {}, auth(founder));
  assert(demoProfile.status === 200, `demo profile ${demoProfile.status}`);
  const totals = (demoProfile.data.totals as { asset: string; deposited: string; withdrawn: string }[]) ?? [];
  const usd = totals.find((row) => row.asset === "USD");
  const ledger = await pool.query(
    `SELECT
       COALESCE(SUM(CASE
         WHEN j.kind IN ('deposit_usd','vault_in') AND p.side = 'credit' THEN p.amount
         WHEN j.kind = 'deposit_reversal' AND p.side = 'debit' THEN -p.amount
         ELSE 0 END),0)::text AS deposited,
       COALESCE(SUM(CASE
         WHEN j.kind IN ('withdraw_usd','vault_out') AND p.side = 'debit' THEN p.amount
         ELSE 0 END),0)::text AS withdrawn
     FROM postings p
     JOIN journal_entries j ON j.id = p.entry_id
     JOIN accounts a ON a.id = p.account_id
     WHERE a.customer_id = $1 AND p.asset = 'USD'`,
    [demoId],
  );
  assert(usd && usd.deposited === String(ledger.rows[0].deposited) && usd.withdrawn === String(ledger.rows[0].withdrawn), `totals ${JSON.stringify(usd)} ledger ${JSON.stringify(ledger.rows[0])}`);
  assert(BigInt(usd.deposited) > BigInt(String(before.rows[0].deposited)), "deposit total did not rise");
  const deposits = (demoProfile.data.deposits as { reference: string; txHash: string; status: string }[]) ?? [];
  assert(deposits.some((row) => row.reference === reference && row.txHash === "0xrun35abc123" && row.status === "credited"), "history missing the credit");

  const availBefore = BigInt(((await call("/api/balances", {}, auth(demo))).data.USD as { available: string }).available);
  const withdrawn = await call("/api/wallet/withdraw", {
    method: "POST",
    body: JSON.stringify({ asset: "USD", amount: "1.00", stepUp: totp(DEMO.secret) }),
  }, auth(demo));
  assert(withdrawn.status === 200 && withdrawn.data.status === "pending", `withdraw ${withdrawn.status} ${JSON.stringify(withdrawn.data)}`);
  const wdId = Number(withdrawn.data.id);
  const journalBefore = await pool.query(
    `SELECT count(*)::int AS n FROM journal_entries j
     JOIN postings p ON p.entry_id = j.id
     JOIN accounts a ON a.id = p.account_id
     WHERE a.customer_id = $1 AND j.kind = 'withdraw_usd'`,
    [demoId],
  );
  const approved = await call(`/api/admin/withdrawals/${wdId}/approve`, {
    method: "POST",
    body: JSON.stringify({ totp: totp(FOUNDER.secret) }),
  }, auth(founder));
  assert(approved.status === 200 && approved.data.status === "approved", `approve ${approved.status} ${JSON.stringify(approved.data)}`);
  const availAfter = BigInt(((await call("/api/balances", {}, auth(demo))).data.USD as { available: string }).available);
  assert(availAfter < availBefore, "approve did not settle");
  const sent = await call(`/api/admin/withdrawals/${wdId}/sent`, {
    method: "POST",
    body: JSON.stringify({ totp: totp(FOUNDER.secret), txHash: "0xsent35abc999" }),
  }, auth(founder));
  assert(sent.status === 200 && sent.data.status === "posted", `sent ${sent.status} ${JSON.stringify(sent.data)}`);
  const availSent = BigInt(((await call("/api/balances", {}, auth(demo))).data.USD as { available: string }).available);
  assert(availSent === availAfter, "mark sent moved the balance");
  const journalAfter = await pool.query(
    `SELECT count(*)::int AS n FROM journal_entries j
     JOIN postings p ON p.entry_id = j.id
     JOIN accounts a ON a.id = p.account_id
     WHERE a.customer_id = $1 AND j.kind = 'withdraw_usd'`,
    [demoId],
  );
  assert(Number(journalAfter.rows[0].n) === Number(journalBefore.rows[0].n) + 1, "mark sent posted another journal row");
  const again = await call(`/api/admin/withdrawals/${wdId}/sent`, {
    method: "POST",
    body: JSON.stringify({ totp: totp(FOUNDER.secret), txHash: "0xsent35abc999" }),
  }, auth(founder));
  assert(again.status === 409, `second sent ${again.status}`);
  const sentAudit = await pool.query(
    `SELECT 1 FROM security_events WHERE kind = 'withdraw_sent' AND detail LIKE $1 LIMIT 1`,
    [`%id=${wdId}%`],
  );
  assert(sentAudit.rowCount === 1, "withdraw_sent audit missing");

  const afterProfile = await call(`/api/admin/customers/${demoId}`, {}, auth(founder));
  const usd2 = ((afterProfile.data.totals as { asset: string; deposited: string; withdrawn: string }[]) ?? []).find((row) => row.asset === "USD");
  const ledger2 = await pool.query(
    `SELECT
       COALESCE(SUM(CASE
         WHEN j.kind IN ('deposit_usd','vault_in') AND p.side = 'credit' THEN p.amount
         WHEN j.kind = 'deposit_reversal' AND p.side = 'debit' THEN -p.amount ELSE 0 END),0)::text AS deposited,
       COALESCE(SUM(CASE
         WHEN j.kind IN ('withdraw_usd','vault_out') AND p.side = 'debit' THEN p.amount ELSE 0 END),0)::text AS withdrawn
     FROM postings p JOIN journal_entries j ON j.id = p.entry_id JOIN accounts a ON a.id = p.account_id
     WHERE a.customer_id = $1 AND p.asset = 'USD'`,
    [demoId],
  );
  assert(usd2 && usd2.deposited === String(ledger2.rows[0].deposited) && usd2.withdrawn === String(ledger2.rows[0].withdrawn), "totals drifted after withdrawal");
  const wdRows = (afterProfile.data.withdrawals as { reference: string; txHash: string; status: string }[]) ?? [];
  assert(wdRows.some((row) => row.reference === `wd-${wdId}` && row.txHash === "0xsent35abc999" && row.status === "posted"), "withdrawal history missing sent row");

  const csv = await call(`/api/admin/customers/${demoId}/deposits.csv`, {}, auth(founder));
  assert(csv.status === 200 && csv.text.includes(demoMe) && csv.text.includes(reference) && csv.text.includes("0xrun35abc123"), "deposit csv");
  assert(String(csv.text.split("\n")[0]).includes("fund_id"), "csv header");
  const wdCsv = await call(`/api/admin/customers/${demoId}/withdrawals.csv`, {}, auth(founder));
  assert(wdCsv.status === 200 && wdCsv.text.includes("0xsent35abc999") && wdCsv.text.includes(demoMe), "withdrawal csv");
  const exported = await pool.query(
    `SELECT 1 FROM security_events WHERE kind = 'customer_export' AND detail LIKE $1 LIMIT 1`,
    [`%user ${demoId}%`],
  );
  assert(exported.rowCount === 1, "export audit missing");

  const note = await call(`/api/admin/customers/${newId}/notes`, {
    method: "POST",
    body: JSON.stringify({ body: "Called back, no payment issue." }),
  }, auth(support));
  assert(note.status === 200, `note ${note.status} ${JSON.stringify(note.data)}`);
  const noted = await pool.query(`SELECT 1 FROM security_events WHERE kind = 'customer_note' AND detail LIKE $1`, [`%user ${newId}%`]);
  assert(noted.rowCount === 1, "note audit missing");

  const supportFreeze = await call(`/api/admin/customers/${newId}/freeze`, {
    method: "POST",
    body: JSON.stringify({ frozen: true, reason: "support should not", totp: totp(SUPPORT.secret) }),
  }, auth(support));
  assert(supportFreeze.status === 403, `support freeze ${supportFreeze.status}`);
  const frozen = await call(`/api/admin/customers/${newId}/freeze`, {
    method: "POST",
    body: JSON.stringify({ frozen: true, reason: "profile check", totp: totp(FOUNDER.secret) }),
  }, auth(founder));
  assert(frozen.status === 200 && frozen.data.status === "approved", `freeze ${frozen.status} ${JSON.stringify(frozen.data)}`);
  const flag = await pool.query(`SELECT frozen FROM users WHERE id = $1`, [newId]);
  assert(flag.rows[0].frozen === true, "freeze did not stick");
  const thawed = await call(`/api/admin/customers/${newId}/freeze`, {
    method: "POST",
    body: JSON.stringify({ frozen: false, reason: "profile check done", totp: totp(FOUNDER.secret) }),
  }, auth(founder));
  assert(thawed.status === 200, `unfreeze ${thawed.status}`);
  const flag2 = await pool.query(`SELECT frozen FROM users WHERE id = $1`, [newId]);
  assert(flag2.rows[0].frozen === false, "left the new user frozen");

  const internal = await pool.query(`SELECT id, email, fund_id FROM users WHERE is_internal_test ORDER BY id LIMIT 1`);
  if (internal.rowCount) {
    const card = await call(`/api/admin/customers/${internal.rows[0].id}`, {}, auth(founder));
    assert(card.status === 200 && (card.data.customer as { internalTest: boolean }).internalTest === true, "internal test not labelled");
    const found = await call(`/api/admin/customers?q=${encodeURIComponent(String(internal.rows[0].fund_id))}`, {}, auth(founder));
    assert(((found.data.customers as { internalTest: boolean }[]) ?? []).some((row) => row.internalTest), "internal test hidden from directory");
  }
  const overview = await call("/api/admin/ops/overview", {}, auth(founder));
  const counted = await pool.query(
    `SELECT count(*)::int AS n FROM users WHERE role = 'customer' AND is_internal_test = false AND address_pool_owner = false`,
  );
  assert(overview.status === 200 && Number(overview.data.customers) === Number(counted.rows[0].n), `public count ${overview.data.customers} vs ${counted.rows[0].n}`);

  const bal = BigInt(((await call("/api/balances", {}, auth(demo))).data.USD as { available: string }).available);
  await call("/api/admin/support/deposit-card", {
    method: "POST",
    body: JSON.stringify({ userId: demoId, asset: "USDT", network: "TRC20" }),
  }, auth(support));
  const bal2 = BigInt(((await call("/api/balances", {}, auth(demo))).data.USD as { available: string }).available);
  assert(bal2 === bal, "chat deposit card changed the balance");

  await pool.end();
  console.log("funds-desk ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
