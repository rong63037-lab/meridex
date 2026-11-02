// Throwaway end-to-end test for manual KYC review. Creates only kyc-test-* users and removes them.
import crypto from "node:crypto";
import pg from "pg";
import { generateTotpSecret, hashPassword, totp } from "../src/crypto.ts";

const G = "http://127.0.0.1:7108";
const db = new pg.Pool({ connectionString: "postgres://meridex:<redacted>@127.0.0.1:5432/meridex" });
const tag = Date.now().toString(36);
const pw = `Kt!${crypto.randomBytes(9).toString("base64url")}9z`;
const results: Record<string, unknown> = {};
const created: number[] = [];

async function post(path: string, body: unknown, token?: string) {
  const r = await fetch(G + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function staff(role: string, email: string) {
  const secret = generateTotpSecret();
  const r = await db.query(
    `INSERT INTO users (email, password_hash, totp_secret, role, entity_id, jurisdiction, kyc_tier) VALUES ($1,$2,$3,$4,'SG-OPCO','SG','staff') RETURNING id`,
    [email, hashPassword(pw), secret, role],
  );
  created.push(Number(r.rows[0].id));
  const login = await post("/api/admin/auth/login", { email, password: pw, totp: totp(secret) });
  if (!login.body.token) throw new Error(`staff login ${role} ${JSON.stringify(login)}`);
  return { id: Number(r.rows[0].id), secret, token: login.body.token as string };
}
async function customer(email: string) {
  const reg = await post("/api/auth/register", { email, password: pw, residenceCountry: "SG" });
  if (!reg.body.totpSecret) throw new Error(`register ${JSON.stringify(reg)}`);
  const id = Number((await db.query(`SELECT id FROM users WHERE email = $1`, [email])).rows[0].id);
  created.push(id);
  const login = await post("/api/auth/login", { email, password: pw, totp: totp(reg.body.totpSecret) });
  if (!login.body.token) throw new Error(`customer login ${JSON.stringify(login)}`);
  return { id, token: login.body.token as string };
}
const kyc = async (id: number) => (await db.query(`SELECT status, reason, entity_id, reviewed_by, review_note FROM kyc_profiles WHERE user_id = $1`, [id])).rows[0];
const ledger = async (id: number) => Number((await db.query(`SELECT count(*) AS n FROM accounts WHERE customer_id = $1`, [id])).rows[0].n);
const wait30 = async () => { const s = (Date.now() / 1000) % 30; if (s > 25) await new Promise((r) => setTimeout(r, (31 - s) * 1000)); };

try {
  const reviewer = await staff("risk", `kyc-test-rev-${tag}@example.test`);
  const support = await staff("support", `kyc-test-sup-${tag}@example.test`);
  const a = await customer(`kyc-test-a-${tag}@example.test`);
  const b = await customer(`kyc-test-b-${tag}@example.test`);
  const self = await customer(`kyc-test-rev-${tag}+c@example.test`);

  const kycBody = { nationality: "SG", residenceCountry: "SG", sanctionsHit: false };
  results.submitA = (await post("/api/kyc", kycBody, a.token)).body;
  results.afterSubmitA = { kyc: await kyc(a.id), ledgerAccounts: await ledger(a.id) };
  await post("/api/kyc", kycBody, b.token);
  await post("/api/kyc", kycBody, self.token);
  results.sanctioned = (await post("/api/kyc", { ...kycBody, sanctionsHit: true }, (await customer(`kyc-test-s-${tag}@example.test`)).token)).body;

  await wait30();
  results.wrongRoleSupport = await post(`/api/admin/kyc/${a.id}/decision`, { action: "approve", reason: "", totp: totp(support.secret) }, support.token);
  results.customerTokenOnAdmin = await post(`/api/admin/kyc/${a.id}/decision`, { action: "approve", reason: "" }, a.token);
  results.selfIdRefused = await post(`/api/admin/kyc/${reviewer.id}/decision`, { action: "approve", reason: "", totp: totp(reviewer.secret) }, reviewer.token);
  results.staffLinkedEmailRefused = await post(`/api/admin/kyc/${self.id}/decision`, { action: "approve", reason: "", totp: totp(reviewer.secret) }, reviewer.token);
  results.noTotp = await post(`/api/admin/kyc/${a.id}/decision`, { action: "approve", reason: "" }, reviewer.token);
  results.rejectNoReason = await post(`/api/admin/kyc/${b.id}/decision`, { action: "reject", reason: "", totp: totp(reviewer.secret) }, reviewer.token);
  results.approveA = await post(`/api/admin/kyc/${a.id}/decision`, { action: "approve", reason: "docs ok (test)", totp: totp(reviewer.secret) }, reviewer.token);
  results.afterApproveA = { kyc: await kyc(a.id), ledgerAccounts: await ledger(a.id) };
  results.approveAgainNotPending = await post(`/api/admin/kyc/${a.id}/decision`, { action: "approve", reason: "", totp: totp(reviewer.secret) }, reviewer.token);
  results.rejectB = await post(`/api/admin/kyc/${b.id}/decision`, { action: "reject", reason: "blurry document (test)", totp: totp(reviewer.secret) }, reviewer.token);
  results.afterRejectB = { kyc: await kyc(b.id), ledgerAccounts: await ledger(b.id) };
  results.securityEvents = (await db.query(`SELECT user_id, kind FROM security_events WHERE user_id = ANY($1) AND kind LIKE 'kyc%' ORDER BY id`, [created])).rows.map((r) => `${r.user_id}:${r.kind}`);
} catch (err) {
  results.error = String(err);
} finally {
  // Cleanup: remove every row that references the throwaway users, then the users.
  const ids = created;
  const refs = await db.query(
    `SELECT tc.table_name, kcu.column_name FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
     JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'users' AND ccu.column_name = 'id'`,
  );
  const cleanup: string[] = [];
  results.cleanupIds = ids;
  results.cleanupBlockedBy = cleanup;
  results.refTables = refs.rows.length;
  await db.end();
  console.log(JSON.stringify(results, null, 1));
}
