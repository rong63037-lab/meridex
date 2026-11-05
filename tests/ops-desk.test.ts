/**
 * Withdrawal queue, deposit reconciliation, backup script, and the admin to-do counts.
 * Runs against a gateway that is already up.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const SUPPORT = { email: "support@meridexexchange.com", password: "<redacted>", secret: "<redacted>" };

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
  assert(res.status === 200, `balances ${res.status}`);
  return BigInt((res.data.USD as { available: string }).available);
}

async function usdReserved(token: string): Promise<bigint> {
  const res = await call("/api/balances", {}, auth(token));
  return BigInt((res.data.USD as { reserved?: string }).reserved ?? "0");
}

async function main() {
  await sleep(400);
  const db = new Pool({ connectionString: dbUrl });
  const founder = await login(FOUNDER.email, FOUNDER.password, FOUNDER.secret);
  const support = await login(SUPPORT.email, SUPPORT.password, SUPPORT.secret);
  const saved = await call("/api/content");
  const previous = Number((saved.data.numbers as Record<string, number>)["withdraw.reviewUsd"] ?? 0);

  async function setReview(value: number) {
    const res = await call("/api/admin/content/number", {
      method: "PUT",
      body: JSON.stringify({ key: "withdraw.reviewUsd", value }),
    }, auth(founder));
    assert(res.status === 200, `set review ${res.status} ${JSON.stringify(res.data)}`);
  }

  const stamp = Date.now().toString(36);
  const email = `wd.${stamp}@meridexexchange.com`;
  const password = "<redacted>";
  let userId = 0;
  try {
    const before = await call("/api/admin/invariants", {}, auth(founder));
    assert(before.status === 200 && before.data.ok === true, `invariants before ${JSON.stringify(before.data)}`);

    const registered = await call("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, residenceCountry: "SG" }),
    });
    assert(registered.status === 200, JSON.stringify(registered.data));
    userId = Number(registered.data.userId);
    const secret = String(registered.data.totpSecret);
    await db.query(`UPDATE users SET entity_id = 'SG-OPCO', jurisdiction = 'SG' WHERE id = $1`, [userId]);
    await db.query(
      `INSERT INTO kyc_profiles (user_id, nationality, residence_country, sanctions_hit, status, reason, entity_id)
       VALUES ($1,'SG','SG',false,'approved','sandbox','SG-OPCO')
       ON CONFLICT (user_id) DO UPDATE SET status = 'approved', entity_id = 'SG-OPCO'`,
      [userId],
    );
    const customer = await login(email, password, secret, "customer");
    const funded = await call("/api/wallet/deposit", {
      method: "POST",
      body: JSON.stringify({ asset: "USD", amount: "30.00" }),
    }, auth(customer));
    assert(funded.status === 200, `fund ${funded.status} ${JSON.stringify(funded.data)}`);
    const start = await usdAvailable(customer);

    await setReview(100);
    await sleep(2100);
    const auto = await withdraw(customer, secret, "1.00");
    assert(auto.status === 200 && auto.data.status === "posted", `auto ${auto.status} ${JSON.stringify(auto.data)}`);
    assert(await usdAvailable(customer) === start - 1_000_000n, "auto withdraw did not leave the account");

    await setReview(0);
    await sleep(2100);
    const heldBefore = await usdReserved(customer);
    const queued = await withdraw(customer, secret, "1.00");
    assert(queued.status === 200 && queued.data.status === "pending", `queue ${queued.status} ${JSON.stringify(queued.data)}`);
    const queuedId = Number(queued.data.id);
    assert(await usdAvailable(customer) === start - 2_000_000n, "pending withdraw did not reserve available");
    assert(await usdReserved(customer) === heldBefore + 1_000_000n, "pending withdraw did not show as reserved");

    const denied = await call(`/api/admin/withdrawals/${queuedId}/approve`, {
      method: "POST",
      body: JSON.stringify({ totp: totp(SUPPORT.secret) }),
    }, auth(support));
    assert(denied.status === 403, `support approve ${denied.status}`);
    const missing = await call(`/api/admin/withdrawals/${queuedId}/approve`, {
      method: "POST",
      body: JSON.stringify({}),
    }, auth(founder));
    assert(missing.status === 401 && missing.data.error === "TOTP_REQUIRED", JSON.stringify(missing.data));
    const approved = await call(`/api/admin/withdrawals/${queuedId}/approve`, {
      method: "POST",
      body: JSON.stringify({ totp: totp(FOUNDER.secret) }),
    }, auth(founder));
    assert(approved.status === 200, `approve ${approved.status} ${JSON.stringify(approved.data)}`);
    assert(await usdAvailable(customer) === start - 2_000_000n, "approve put the funds back");
    assert(await usdReserved(customer) === heldBefore, "approve left the hold in place");

    await sleep(2100);
    const rejectMe = await withdraw(customer, secret, "1.00");
    assert(rejectMe.data.status === "pending", JSON.stringify(rejectMe.data));
    const bare = await call(`/api/admin/withdrawals/${rejectMe.data.id}/reject`, {
      method: "POST",
      body: JSON.stringify({ totp: totp(FOUNDER.secret) }),
    }, auth(founder));
    assert(bare.status === 400, `reject without reason ${bare.status}`);
    const rejected = await call(`/api/admin/withdrawals/${rejectMe.data.id}/reject`, {
      method: "POST",
      body: JSON.stringify({ totp: totp(FOUNDER.secret), reason: "test release" }),
    }, auth(founder));
    assert(rejected.status === 200, `reject ${rejected.status} ${JSON.stringify(rejected.data)}`);
    assert(await usdAvailable(customer) === start - 2_000_000n, "reject did not release the hold");

    const notices = await call("/api/notifications", {}, auth(customer));
    const titles = ((notices.data.messages as { title?: string }[] | undefined) ?? []).map((row) => row.title).join(" ");
    assert(titles.includes("出金"), `customer was not notified ${titles}`);

    await sleep(2100);
    const rail = await call("/api/wallet/rails", {
      method: "POST",
      body: JSON.stringify({ direction: "withdraw", amount: "2.00", stepUp: totp(secret) }),
    }, auth(customer));
    assert(rail.status === 200 && rail.data.status === "pending", `rail ${rail.status} ${JSON.stringify(rail.data)}`);
    const railReject = await call(`/api/admin/withdrawals/${rail.data.id}/reject`, {
      method: "POST",
      body: JSON.stringify({ totp: totp(FOUNDER.secret), reason: "rail release" }),
    }, auth(founder));
    assert(railReject.status === 200, JSON.stringify(railReject.data));

    const bigIn = await call("/api/wallet/deposit", {
      method: "POST",
      body: JSON.stringify({ asset: "USD", amount: "20000.00" }),
    }, auth(customer));
    assert(bigIn.status === 200, `big deposit ${bigIn.status}`);
    await sleep(2100);
    const big = await withdraw(customer, secret, "20000.00");
    assert(big.data.status === "pending", `big ${JSON.stringify(big.data)}`);
    let flagged = 0;
    for (let i = 0; i < 8 && flagged === 0; i += 1) {
      await sleep(250);
      const rows = await db.query(
        `SELECT count(*)::int AS n FROM surv_alerts WHERE user_id = $1 AND rule_id = 'large_withdraw' AND created_at > now() - interval '10 minutes'`,
        [userId],
      );
      flagged = Number(rows.rows[0].n);
    }
    assert(flagged > 0, "large withdrawal did not open a surveillance alert");
    const bigReject = await call(`/api/admin/withdrawals/${big.data.id}/reject`, {
      method: "POST",
      body: JSON.stringify({ totp: totp(FOUNDER.secret), reason: "flag check" }),
    }, auth(founder));
    assert(bigReject.status === 200, JSON.stringify(bigReject.data));

    const internal = await call("/api/admin/internal-test", {
      method: "POST",
      body: JSON.stringify({ email: `play.${stamp}@meridexexchange.com`, name: "Play", password, totp: true }),
    }, auth(founder));
    assert(internal.status === 200 && internal.data.totpSecret, JSON.stringify(internal.data));
    const playToken = await login(`play.${stamp}@meridexexchange.com`, password, String(internal.data.totpSecret), "customer");
    const playWd = await call("/api/wallet/withdraw", {
      method: "POST",
      body: JSON.stringify({ asset: "USD", amount: "1.00", stepUp: totp(String(internal.data.totpSecret)) }),
    }, auth(playToken));
    assert(playWd.status === 403 && playWd.data.error === "PLAY_ONLY", JSON.stringify(playWd.data));
    const playRows = await db.query(`SELECT count(*)::int AS n FROM withdrawal_requests WHERE user_id = $1`, [internal.data.id]);
    assert(Number(playRows.rows[0].n) === 0, "internal test wrote a withdrawal row");
    const removed = await call(`/api/admin/internal-test/${internal.data.id}`, { method: "DELETE" }, auth(founder));
    assert(removed.status === 200, `delete internal ${removed.status}`);

    const ref = `CLAIM${stamp}`;
    const claim = await call("/api/wallet/deposit-claims", {
      method: "POST",
      body: JSON.stringify({ asset: "USD", network: "Bank", amount: "3.00", reference: ref }),
    }, auth(customer));
    assert(claim.status === 200, `claim ${claim.status} ${JSON.stringify(claim.data)}`);
    const board = await call("/api/admin/deposits/reconcile?filter=unmatched", {}, auth(founder));
    const rows = (board.data.rows as { reference?: string; kind?: string }[] | undefined) ?? [];
    assert(board.status === 200 && rows.some((row) => row.reference === ref && row.kind === "claim"), "unmatched board missed the claim");
    const csv = await call("/api/admin/deposits/reconcile.csv?filter=claims", {}, auth(support));
    assert(csv.status === 200 && String(csv.data.raw ?? "").includes(ref), "csv missed the claim");

    const todo = await call("/api/admin/todo", {}, auth(support));
    assert(todo.status === 200 && Number(todo.data.claims) >= 1, `todo ${JSON.stringify(todo.data)}`);
    assert(typeof todo.data.withdrawals === "number" && typeof todo.data.kyc === "number" && typeof todo.data.chats === "number", "todo missing counts");
    const backup = await call("/api/admin/backup", {}, auth(founder));
    assert(backup.status === 200 && ["ok", "failed", "none"].includes(String(backup.data.status)), JSON.stringify(backup.data));

    const help = await call("/api/help?q=whitelist");
    const articles = (help.data.articles as { title_ms?: string; body_ms?: string }[] | undefined) ?? [];
    assert(articles.some((row) => (row.title_ms ?? "").includes("Senarai")), `help ms ${JSON.stringify(articles)}`);

    const after = await call("/api/admin/invariants", {}, auth(founder));
    assert(after.status === 200 && after.data.ok === true, `invariants after ${JSON.stringify(after.data)}`);
    runBackup();
    console.log("ops desk checks ok");
  } finally {
    await setReview(previous).catch(() => undefined);
    if (userId) {
      await db.query(`DELETE FROM deposit_claims WHERE user_id = $1 AND reference LIKE $2`, [userId, `CLAIM${stamp}%`]).catch(() => undefined);
    }
    await db.end();
  }
}

async function withdraw(token: string, secret: string, amount: string) {
  let last = await call("/api/wallet/withdraw", {
    method: "POST",
    body: JSON.stringify({ asset: "USD", amount, stepUp: totp(secret) }),
  }, auth(token));
  for (let i = 0; i < 6 && last.status === 429; i += 1) {
    await sleep(1200);
    last = await call("/api/wallet/withdraw", {
      method: "POST",
      body: JSON.stringify({ asset: "USD", amount, stepUp: totp(secret) }),
    }, auth(token));
  }
  return last;
}

function runBackup() {
  const dir = mkdtempSync(join(tmpdir(), "meridex-bak-"));
  try {
    for (let i = 0; i < 8; i += 1) writeFileSync(join(dir, `meridex-2000010${i}-00000${i}.dump`), "old");
    execFileSync("sh", ["scripts/backup-db.sh"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, MERIDEX_BACKUP_DIR: dir, DATABASE_URL: dbUrl },
      stdio: "pipe",
    });
    const dumps = readdirSync(dir).filter((name) => name.endsWith(".dump"));
    assert(dumps.length === 7, `kept ${dumps.length} dumps`);
    const latest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8")) as { ok?: boolean; file?: string };
    assert(latest.ok === true && latest.file, "latest.json was not written");
    const scratch = `meridex_restore_${Date.now().toString(36)}`;
    const env = { ...process.env, PGPASSWORD: "meridex" };
    try {
      execFileSync("createdb", ["-h", "127.0.0.1", "-U", "meridex", scratch], { env, stdio: "pipe" });
    } catch {
      execFileSync("sudo", ["-n", "-u", "postgres", "createdb", "-O", "meridex", scratch], { stdio: "pipe" });
    }
    try {
      try {
        execFileSync("pg_restore", ["--no-owner", "--dbname", `postgres://meridex:<redacted>@127.0.0.1:5432/${scratch}`, latest.file], { stdio: "pipe" });
      } catch {
        // pg_restore exits 1 when it only has warnings.
      }
      const out = execFileSync("psql", ["-h", "127.0.0.1", "-U", "meridex", "-d", scratch, "-tAc", "SELECT count(*) FROM users"], { env, encoding: "utf8" });
      assert(Number(out.trim()) > 0, "restored database has no users");
    } finally {
      try {
        execFileSync("dropdb", ["-h", "127.0.0.1", "-U", "meridex", scratch], { env, stdio: "pipe" });
      } catch {
        execFileSync("sudo", ["-n", "-u", "postgres", "dropdb", "--if-exists", scratch], { stdio: "pipe" });
      }
    }
    execFileSync("sh", ["scripts/backup-db.sh"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: "pipe",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
