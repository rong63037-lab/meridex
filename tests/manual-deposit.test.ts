/**
 * Manual deposit credits against a running gateway.
 * Ledger invariants, duplicate reference, TOTP, role gates, internal-test rejection, reversal.
 */
import { createRequire } from "node:module";
import { totp } from "../gateway/src/crypto.ts";

const require = createRequire(new URL("../gateway/package.json", import.meta.url));
const { Pool } = require("pg") as {
  Pool: new (cfg: { connectionString: string }) => {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
    end: () => Promise<void>;
  };
};

const base = process.env.GATEWAY_URL ?? "http://127.0.0.1:7108";
const dbUrl = process.env.DATABASE_URL ?? "postgres://meridex:<redacted>@127.0.0.1:5432/meridex";

const FOUNDER = { email: "founder@meridexexchange.com", password: "<redacted>", secret: "<redacted>" };
const OPS = { email: "ops@meridexexchange.com", password: "<redacted>", secret: "<redacted>" };
const SUPPORT = { email: "support@meridexexchange.com", password: "<redacted>", secret: "<redacted>" };
const RISK = { email: "risk@meridexexchange.com", password: "<redacted>", secret: "<redacted>" };
const COMPLIANCE = { email: "compliance@meridexexchange.com", password: "<redacted>", secret: "<redacted>" };
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
  return { status: res.status, data };
}

async function login(email: string, password: string, secret: string, portal: "customer" | "staff" = "staff") {
  const path = portal === "staff" ? "/api/admin/auth/login" : "/api/auth/login";
  let last = await call(path, { method: "POST", body: JSON.stringify({ email, password, totp: totp(secret) }) });
  for (let i = 0; i < 6 && last.status === 429; i += 1) {
    await sleep(1000);
    last = await call(path, { method: "POST", body: JSON.stringify({ email, password, totp: totp(secret) }) });
  }
  assert(last.status === 200 && typeof last.data.token === "string", `login ${email} ${last.status} ${JSON.stringify(last.data)}`);
  return String(last.data.token);
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function usdAvailable(token: string): Promise<bigint> {
  const res = await call("/api/balances", {}, auth(token));
  assert(res.status === 200, `balances ${res.status} ${JSON.stringify(res.data)}`);
  const slot = res.data.USD as { available?: string } | undefined;
  assert(slot?.available, `no USD slot ${JSON.stringify(res.data)}`);
  return BigInt(slot.available);
}

async function assetAvailable(token: string, asset: string): Promise<bigint> {
  const res = await call("/api/balances", {}, auth(token));
  const assets = res.data.assets as { asset: string; available: string }[] | undefined;
  const hit = assets?.find((row) => row.asset === asset);
  return BigInt(hit?.available ?? "0");
}

const stamp = Date.now().toString(36);
let n = 0;
function ref(prefix: string) {
  n += 1;
  return `${prefix}${stamp}${n}`;
}

async function main() {
  await sleep(500);
  const db = new Pool({ connectionString: dbUrl });
  const founder = await login(FOUNDER.email, FOUNDER.password, FOUNDER.secret);
  const ops = await login(OPS.email, OPS.password, OPS.secret);
  const support = await login(SUPPORT.email, SUPPORT.password, SUPPORT.secret);
  const risk = await login(RISK.email, RISK.password, RISK.secret);
  const compliance = await login(COMPLIANCE.email, COMPLIANCE.password, COMPLIANCE.secret);
  const demo = await login(DEMO.email, DEMO.password, DEMO.secret, "customer");
  const demoIdRow = await db.query(`SELECT id FROM users WHERE email = $1`, [DEMO.email]);
  const demoId = Number(demoIdRow.rows[0].id);
  const founderId = Number((await db.query(`SELECT id FROM users WHERE email = $1`, [FOUNDER.email])).rows[0].id);

  const beforeLock = await db.query(`SELECT fails FROM totp_lockouts WHERE user_id = $1`, [founderId]);
  const failsBefore = Number(beforeLock.rows[0]?.fails ?? 0);

  const inv = await call("/api/admin/invariants", {}, auth(founder));
  assert(inv.status === 200 && inv.data.ok === true, `invariants before ${JSON.stringify(inv.data)}`);

  const content = await call("/api/content");
  const numbers = content.data.numbers as Record<string, number>;
  const saved = {
    fee: numbers["deposit.feeUsd"] ?? 0,
    max: numbers["deposit.maxUsd"] ?? 0,
    flag: numbers["deposit.flagUsd"] ?? 10000,
  };

  async function setNumber(key: string, value: number) {
    const res = await call("/api/admin/content/number", { method: "PUT", body: JSON.stringify({ key, value }) }, auth(founder));
    assert(res.status === 200, `set ${key} ${res.status} ${JSON.stringify(res.data)}`);
  }

  async function postCredit(token: string, secret: string, body: Record<string, unknown>, code?: string) {
    return call("/api/admin/manual-deposits", {
      method: "POST",
      body: JSON.stringify({ receivedAt: new Date().toISOString(), confirm: true, totp: code === undefined ? totp(secret) : code, ...body }),
    }, auth(token));
  }

  async function reverse(token: string, secret: string, id: number, reason: string) {
    return call(`/api/admin/manual-deposits/${id}/reverse`, {
      method: "POST",
      body: JSON.stringify({ reason, totp: totp(secret) }),
    }, auth(token));
  }

  try {
    const noConfirm = await postCredit(founder, FOUNDER.secret, {
      userId: demoId, asset: "USD", network: "Bank", amount: "1.00", reference: ref("NC"), confirm: false,
    });
    assert(noConfirm.status === 400 && noConfirm.data.error === "CONFIRM_REQUIRED", JSON.stringify(noConfirm));

    const noTotp = await postCredit(founder, FOUNDER.secret, {
      userId: demoId, asset: "USD", network: "Bank", amount: "1.00", reference: ref("NT"),
    }, "");
    assert(noTotp.status === 401 && noTotp.data.error === "TOTP_REQUIRED", JSON.stringify(noTotp));
    const afterLock = await db.query(`SELECT fails FROM totp_lockouts WHERE user_id = $1`, [founderId]);
    assert(Number(afterLock.rows[0]?.fails ?? 0) === failsBefore, "missing TOTP incremented the lockout");

    for (const [name, token] of [["support", support], ["risk", risk], ["compliance", compliance]] as const) {
      const denied = await postCredit(token, FOUNDER.secret, {
        userId: demoId, asset: "USD", network: "Bank", amount: "1.00", reference: ref(name),
      });
      assert(denied.status === 403, `${name} credit ${denied.status} ${JSON.stringify(denied.data)}`);
    }
    const customerDenied = await postCredit(demo, DEMO.secret, {
      userId: demoId, asset: "USD", network: "Bank", amount: "1.00", reference: ref("CUST"),
    });
    assert(customerDenied.status === 403, `customer credit ${customerDenied.status}`);

    const chatBefore = await usdAvailable(demo);
    const chat = await call("/api/support/chat", {
      method: "POST",
      body: JSON.stringify({ body: `Please credit tx ${ref("CHAT")} amount 50`, topic: "deposit" }),
    }, auth(demo));
    assert(chat.status === 200, `chat ${chat.status} ${JSON.stringify(chat.data)}`);
    assert(await usdAvailable(demo) === chatBefore, "support chat changed the balance");
    const staffChat = await call("/api/admin/support/chat", {
      method: "POST",
      body: JSON.stringify({ userId: demoId, body: "Crediting your transfer now" }),
    }, auth(support));
    assert(staffChat.status === 200, `staff chat ${staffChat.status} ${JSON.stringify(staffChat.data)}`);
    assert(await usdAvailable(demo) === chatBefore, "staff chat changed the balance");

    const internal = await call("/api/admin/internal-test", {
      method: "POST",
      body: JSON.stringify({
        email: `play.manual.${stamp}@meridexexchange.com`,
        name: "Manual play",
        password: "<redacted>",
        totp: false,
      }),
    }, auth(founder));
    assert(internal.status === 200, `internal create ${internal.status} ${JSON.stringify(internal.data)}`);
    const internalId = Number(internal.data.id);
    const playBefore = await db.query(
      `SELECT
         (SELECT count(*)::int FROM play_balances WHERE user_id = $1) AS bal,
         (SELECT count(*)::int FROM play_moves WHERE user_id = $1) AS moves,
         (SELECT count(*)::int FROM accounts WHERE customer_id = $1) AS accts`,
      [internalId],
    );
    const playDenied = await postCredit(founder, FOUNDER.secret, {
      userId: internalId, asset: "USD", network: "Bank", amount: "8.00", reference: ref("PLAY"),
    });
    assert(playDenied.status === 403 && playDenied.data.error === "PLAY_ONLY", JSON.stringify(playDenied));
    const playAfter = await db.query(
      `SELECT
         (SELECT count(*)::int FROM play_balances WHERE user_id = $1) AS bal,
         (SELECT count(*)::int FROM play_moves WHERE user_id = $1) AS moves,
         (SELECT count(*)::int FROM accounts WHERE customer_id = $1) AS accts`,
      [internalId],
    );
    assert(JSON.stringify(playBefore.rows[0]) === JSON.stringify(playAfter.rows[0]), "internal credit touched play or ledger accounts");
    const searched = await call(`/api/admin/manual-deposits/customers?q=${encodeURIComponent(`play.manual.${stamp}@meridexexchange.com`)}`, {}, auth(founder));
    assert(searched.status === 200 && (searched.data.internalTest as { id: number }).id === internalId, JSON.stringify(searched.data));
    assert((searched.data.matches as unknown[]).length === 0, "internal account was offered for credit");

    const happyRef = ref("USD");
    const before = await usdAvailable(demo);
    const happy = await postCredit(founder, FOUNDER.secret, {
      userId: demoId, asset: "USD", network: "Bank", amount: "3.25", reference: happyRef, note: "wire", screenshotUrl: "https://example.test/shot.png",
    });
    assert(happy.status === 200, JSON.stringify(happy));
    assert(happy.data.net === "3.25" && happy.data.fee === "0.00", JSON.stringify(happy.data));
    assert(await usdAvailable(demo) === before + 3_250_000n, "USD balance did not rise by the net credit");
    const journal = await db.query(
      `SELECT kind, ref FROM journal_entries WHERE ref = $1`,
      [`manual:USD:${happyRef}`],
    );
    assert(journal.rows[0]?.kind === "deposit_usd", JSON.stringify(journal.rows));
    const audit = await db.query(
      `SELECT detail FROM security_events WHERE kind = 'manual_deposit' AND detail LIKE $1 ORDER BY id DESC LIMIT 1`,
      [`%ref ${happyRef}%`],
    );
    assert(String(audit.rows[0]?.detail ?? "").includes(happyRef), "missing audit row");
    const notice = await db.query(
      `SELECT body FROM notification_outbox WHERE user_id = $1 AND body LIKE $2 ORDER BY created_at DESC LIMIT 1`,
      [demoId, `%${happyRef}%`],
    );
    assert(String(notice.rows[0]?.body ?? "").includes(happyRef), "missing inbox notice");

    const dup = await postCredit(founder, FOUNDER.secret, {
      userId: demoId, asset: "USD", network: "Bank", amount: "3.25", reference: happyRef.toLowerCase(),
    });
    assert(dup.status === 409 && dup.data.error === "DUPLICATE_REFERENCE", JSON.stringify(dup));
    assert(await usdAvailable(demo) === before + 3_250_000n, "duplicate credit changed the balance");

    const btcBefore = await assetAvailable(demo, "BTC");
    const btc = await postCredit(founder, FOUNDER.secret, {
      userId: demoId, asset: "BTC", network: "Bitcoin", amount: "0.01", reference: happyRef,
    });
    assert(btc.status === 200, `same ref other asset ${btc.status} ${JSON.stringify(btc.data)}`);
    assert(await assetAvailable(demo, "BTC") === btcBefore + 1_000_000n, "BTC credit did not post");

    const claimRef = ref("CLAIM");
    const claim = await call("/api/wallet/deposit-claims", {
      method: "POST",
      body: JSON.stringify({ asset: "USD", network: "Bank", amount: "2.5", reference: claimRef }),
    }, auth(demo));
    assert(claim.status === 200 && (claim.data.claim as { status: string }).status === "pending", JSON.stringify(claim.data));
    assert(await usdAvailable(demo) === before + 3_250_000n, "customer claim credited the balance");
    const preview = await call(
      `/api/admin/manual-deposits/preview?userId=${demoId}&asset=USD&network=Bank&amount=2.50`,
      {},
      auth(founder),
    );
    const claims = preview.data.claims as { reference: string; id: number }[];
    const pending = claims.find((row) => row.reference === claimRef);
    assert(preview.status === 200 && pending, `preview missing claim ${JSON.stringify(preview.data)}`);
    const fromClaim = await postCredit(founder, FOUNDER.secret, {
      userId: demoId, asset: "USD", network: "Bank", amount: "2.50", reference: claimRef, claimId: pending.id,
    });
    assert(fromClaim.status === 200, JSON.stringify(fromClaim));
    const claimRow = await db.query(`SELECT status FROM deposit_claims WHERE id = $1`, [pending.id]);
    assert(claimRow.rows[0]?.status === "credited", "claim was not marked credited");

    const opsRef = ref("OPS");
    const opsCredit = await postCredit(ops, OPS.secret, {
      userId: demoId, asset: "USD", network: "PayNow", amount: "1.00", reference: opsRef,
    });
    assert(opsCredit.status === 200, `ops credit ${opsCredit.status} ${JSON.stringify(opsCredit.data)}`);
    const opsReverse = await reverse(ops, OPS.secret, Number(opsCredit.data.id), "ops must not reverse");
    assert(opsReverse.status === 403, `ops reverse ${opsReverse.status}`);
    const founderReverse = await reverse(founder, FOUNDER.secret, Number(opsCredit.data.id), "ops credit withdrawn by owner");
    assert(founderReverse.status === 200, JSON.stringify(founderReverse));
    const twice = await reverse(founder, FOUNDER.secret, Number(opsCredit.data.id), "second reverse");
    assert(twice.status === 409 && twice.data.error === "ALREADY_REVERSED", JSON.stringify(twice));

    await setNumber("deposit.feeUsd", 1);
    const reg = await call("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: `fee.manual.${stamp}@meridexexchange.com`,
        password: "<redacted>",
        residenceCountry: "SG",
      }),
    });
    assert(reg.status === 200 && reg.data.totpSecret, JSON.stringify(reg.data));
    const feeUser = Number(reg.data.userId);
    const feeSecret = String(reg.data.totpSecret);
    await db.query(`UPDATE users SET entity_id = 'SG-OPCO', jurisdiction = 'SG' WHERE id = $1`, [feeUser]);
    await db.query(
      `INSERT INTO kyc_profiles (user_id, nationality, residence_country, sanctions_hit, status, reason, entity_id)
       VALUES ($1,'SG','SG',false,'approved','sandbox','SG-OPCO')`,
      [feeUser],
    );
    const feeToken = await login(`fee.manual.${stamp}@meridexexchange.com`, "<redacted>", feeSecret, "customer");
    const feeCredit = await postCredit(founder, FOUNDER.secret, {
      userId: feeUser, asset: "USD", network: "Bank", amount: "10.00", reference: ref("FEE"),
    });
    assert(feeCredit.status === 200 && feeCredit.data.fee === "1.00" && feeCredit.data.net === "9.00", JSON.stringify(feeCredit.data));
    assert(await usdAvailable(feeToken) === 9_000_000n, "fee was not withheld from the credit");
    const feeRev = await reverse(founder, FOUNDER.secret, Number(feeCredit.data.id), "fee path reversal");
    assert(feeRev.status === 200, JSON.stringify(feeRev));
    assert(await usdAvailable(feeToken) === 0n, "reversal did not restore the net credit");
    const revJournal = await db.query(`SELECT kind FROM journal_entries WHERE ref LIKE $1`, [`reverse:manual:USD:%${String(feeCredit.data.reference)}%`]);
    assert(revJournal.rows.some((row) => row.kind === "deposit_reversal"), "reversal was not a deposit_reversal");
    await setNumber("deposit.feeUsd", saved.fee);

    await setNumber("deposit.maxUsd", 5);
    const limited = await postCredit(founder, FOUNDER.secret, {
      userId: demoId, asset: "USD", network: "Bank", amount: "6.00", reference: ref("MAX"),
    });
    assert(limited.status === 400 && limited.data.error === "AMOUNT_LIMIT", JSON.stringify(limited));
    await setNumber("deposit.maxUsd", saved.max);

    await setNumber("deposit.flagUsd", 1);
    const flagged = await postCredit(founder, FOUNDER.secret, {
      userId: demoId, asset: "USD", network: "Bank", amount: "2.00", reference: ref("FLAG"),
    });
    assert(flagged.status === 200 && flagged.data.flagged === true, JSON.stringify(flagged.data));
    const alert = await db.query(
      `SELECT id FROM surv_alerts WHERE rule_id = 'large_manual_deposit' AND user_id = $1 AND detail LIKE $2`,
      [demoId, `%${String(flagged.data.reference)}%`],
    );
    assert(alert.rowCount === 1, "large credit was not flagged");
    const flagRev = await reverse(founder, FOUNDER.secret, Number(flagged.data.id), "flag path reversal");
    assert(flagRev.status === 200, JSON.stringify(flagRev));
    await setNumber("deposit.flagUsd", saved.flag);

    const drainReg = await call("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        email: `drain.manual.${stamp}@meridexexchange.com`,
        password: "<redacted>",
        residenceCountry: "SG",
      }),
    });
    assert(drainReg.status === 200, JSON.stringify(drainReg.data));
    const drainId = Number(drainReg.data.userId);
    const drainSecret = String(drainReg.data.totpSecret);
    await db.query(`UPDATE users SET entity_id = 'SG-OPCO', jurisdiction = 'SG' WHERE id = $1`, [drainId]);
    await db.query(
      `INSERT INTO kyc_profiles (user_id, nationality, residence_country, sanctions_hit, status, reason, entity_id)
       VALUES ($1,'SG','SG',false,'approved','sandbox','SG-OPCO')`,
      [drainId],
    );
    const drainToken = await login(`drain.manual.${stamp}@meridexexchange.com`, "<redacted>", drainSecret, "customer");
    const drainCredit = await postCredit(founder, FOUNDER.secret, {
      userId: drainId, asset: "USD", network: "Bank", amount: "4.00", reference: ref("DRAIN"),
    });
    assert(drainCredit.status === 200, JSON.stringify(drainCredit));
    const withdrawn = await call("/api/wallet/withdraw", {
      method: "POST",
      body: JSON.stringify({ asset: "USD", amount: "4.00", stepUp: totp(drainSecret) }),
    }, auth(drainToken));
    assert(withdrawn.status === 200, `withdraw ${withdrawn.status} ${JSON.stringify(withdrawn.data)}`);
    if (withdrawn.data.status === "pending") {
      const approved = await call(`/api/admin/withdrawals/${withdrawn.data.id}/approve`, {
        method: "POST",
        body: JSON.stringify({ totp: totp(FOUNDER.secret) }),
      }, auth(founder));
      assert(approved.status === 200, `approve drain withdraw ${approved.status} ${JSON.stringify(approved.data)}`);
    }
    const short = await reverse(founder, FOUNDER.secret, Number(drainCredit.data.id), "funds already withdrawn");
    assert(short.status === 400 && short.data.error === "INSUFFICIENT_FUNDS", JSON.stringify(short));
    const still = await db.query(`SELECT reversed_at FROM manual_deposits WHERE id = $1`, [drainCredit.data.id]);
    assert(still.rows[0]?.reversed_at == null, "failed reversal marked the credit reversed");

    const happyRev = await reverse(founder, FOUNDER.secret, Number(happy.data.id), "close happy path");
    assert(happyRev.status === 200, JSON.stringify(happyRev));
    const btcRev = await reverse(founder, FOUNDER.secret, Number(btc.data.id), "close btc path");
    assert(btcRev.status === 200, JSON.stringify(btcRev));
    const claimRev = await reverse(founder, FOUNDER.secret, Number(fromClaim.data.id), "close claim path");
    assert(claimRev.status === 200, JSON.stringify(claimRev));
    assert(await usdAvailable(demo) === before, "demo USD balance was not restored");
    assert(await assetAvailable(demo, "BTC") === btcBefore, "demo BTC balance was not restored");

    const csv = await call(`/api/admin/manual-deposits.csv?q=${encodeURIComponent(happyRef)}`, {}, auth(founder));
    assert(csv.status === 200 && String(csv.data.raw ?? "").includes(happyRef), "csv missing the reference");

    const removed = await call(`/api/admin/internal-test/${internalId}`, { method: "DELETE" }, auth(founder));
    assert(removed.status === 200, `delete internal ${removed.status} ${JSON.stringify(removed.data)}`);

    const after = await call("/api/admin/invariants", {}, auth(founder));
    assert(after.status === 200 && after.data.ok === true, `invariants after ${JSON.stringify(after.data)}`);
    console.log("manual deposit checks ok");
  } finally {
    await setNumber("deposit.feeUsd", saved.fee).catch(() => undefined);
    await setNumber("deposit.maxUsd", saved.max).catch(() => undefined);
    await setNumber("deposit.flagUsd", saved.flag).catch(() => undefined);
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
