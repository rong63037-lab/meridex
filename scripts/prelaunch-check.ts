/**
 * Read-only go-live check for the local sandbox.
 * A FAIL is expected until the owner rotates credentials, turns seeding off,
 * and completes the gates in docs/LAUNCH_GATES.md. This file is excluded from
 * the repo secret scan because it holds the denylist used for comparison.
 */
import fs from "node:fs";
import path from "node:path";
import { demoAddress, normalizeAddress, PAIRS } from "../gateway/src/addresses.ts";
import { verifyPassword } from "../gateway/src/crypto.ts";
import {
  backupDir,
  databaseUrl,
  findGateway,
  openPool,
  REMOVAL_EMAILS,
  REMOVAL_IDS,
  root,
  scheduledBackup,
  SEED_CONTENT,
} from "./prelaunch-lib.ts";

const PASSWORDS = [
  "<redacted>",
  "<redacted>",
  "<redacted>",
  "<redacted>",
  "<redacted>",
  "<redacted>",
];

const TOTP_SEEDS = [
  "<redacted>",
  "<redacted>",
  "<redacted>",
  "<redacted>",
  "<redacted>",
  "<redacted>",
  "<redacted>",
  "<redacted>",
  "<redacted>",
  "<redacted>",
  "<redacted>",
  "<redacted>",
  "<redacted>",
  "<redacted>",
  "<redacted>",
  "<redacted>",
  "<redacted>",
  "<redacted>",
  "<redacted>",
  "<redacted>",
];

const JWT_DEFAULT = "<redacted>";
const DB_DEFAULT = "meridex:meridex";
const OWNER_PASSWORD = "<redacted>";
const OWNER_TOTP = "<redacted>";

type Status = "PASS" | "FAIL";
type Row = { id: string; status: Status; detail: string };

const skipDirs = new Set(["node_modules", ".git", ".next", "target", "data", "coverage", "dist", ".turbo"]);
const skipExt = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".gz", ".zip", ".dump", ".woff", ".woff2", ".ttf", ".mp4", ".wasm"]);

function sandboxAddresses(): Set<string> {
  const out = new Set<string>();
  for (const pair of PAIRS) {
    for (let n = 1; n <= 8; n += 1) out.add(normalizeAddress(demoAddress(pair.asset, pair.network, n)));
  }
  return out;
}

function walk(dir: string, hit: string[]): void {
  for (const name of fs.readdirSync(dir)) {
    if (skipDirs.has(name)) continue;
    const full = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      walk(full, hit);
      continue;
    }
    if (!st.isFile() || st.size > 1_500_000) continue;
    if (skipExt.has(path.extname(name).toLowerCase())) continue;
    const rel = path.relative(root, full);
    if (rel === "scripts/prelaunch-check.ts" || rel === "PRELAUNCH_REPORT.md") continue;
    let buf: Buffer;
    try {
      buf = fs.readFileSync(full);
    } catch {
      continue;
    }
    if (buf.includes(0)) continue;
    const text = buf.toString("utf8");
    const secret =
      PASSWORDS.some((item) => text.includes(item)) ||
      TOTP_SEEDS.some((item) => text.includes(item)) ||
      text.includes(JWT_DEFAULT) ||
      text.includes(`${DB_DEFAULT}@`) ||
      text.includes(`postgres://meridex:meridex`);
    if (secret) hit.push(rel);
  }
}

function readText(rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function cookieLiterals(source: string): string[] {
  return [...source.matchAll(/`meridex_(?:staff|pool|customer)=[^`]*`|"meridex_(?:staff|pool|customer)=[^"]*"/g)].map((m) => m[0]);
}

async function fetchJson(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const gateway = findGateway();
  const env = gateway?.env ?? {};
  const url = databaseUrl(gateway);
  const pool = openPool(url);
  const rows: Row[] = [];
  const push = (id: string, status: Status, detail: string) => rows.push({ id, status, detail });

  try {
    await pool.query("SET default_transaction_read_only = on");
    const users = await pool.query<{
      email: string;
      password_hash: string;
      totp_secret: string;
      address_pool_owner: boolean;
      is_internal_test: boolean;
      role: string;
    }>(`SELECT email, password_hash, totp_secret, address_pool_owner, is_internal_test, role FROM users`);

    let passwordHits = 0;
    let totpHits = 0;
    for (const user of users.rows) {
      if (PASSWORDS.some((password) => verifyPassword(password, user.password_hash))) passwordHits += 1;
      if (TOTP_SEEDS.includes(user.totp_secret)) totpHits += 1;
    }
    push(
      "db_published_passwords",
      passwordHits === 0 ? "PASS" : "FAIL",
      passwordHits === 0
        ? "no account password matches a published sandbox password"
        : `${passwordHits} accounts still match a published sandbox password`,
    );
    push(
      "db_published_totp",
      totpHits === 0 ? "PASS" : "FAIL",
      totpHits === 0
        ? "no account stores a published sandbox TOTP seed"
        : `${totpHits} accounts still store a published sandbox TOTP seed`,
    );

    const owner = users.rows.find((user) => user.address_pool_owner);
    push(
      "owner_account_present",
      owner ? "PASS" : "FAIL",
      owner ? `pool owner is ${owner.email}` : "no address_pool_owner row",
    );
    const ownerPassword = !!owner && verifyPassword(OWNER_PASSWORD, owner.password_hash);
    const ownerTotp = !!owner && owner.totp_secret === OWNER_TOTP;
    const ownerRotated = !!owner && !ownerPassword && !ownerTotp;
    push(
      "owner_credentials_rotated",
      ownerRotated ? "PASS" : "FAIL",
      ownerRotated
        ? "owner password and TOTP no longer match the published sandbox pair"
        : `owner password ${ownerPassword ? "still matches" : "does not match"}; owner TOTP ${ownerTotp ? "still matches" : "does not match"}`,
    );

    const removal = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE id IN ${REMOVAL_IDS}`,
      [REMOVAL_EMAILS],
    );
    const flagged = users.rows.filter((user) => user.is_internal_test).length;
    const removalN = Number(removal.rows[0].n);
    push(
      "internal_test_excluded",
      removalN === 0 && flagged === 0 ? "PASS" : "FAIL",
      removalN === 0 && flagged === 0
        ? "no seed, bot, audit, or internal-test accounts remain"
        : `${removalN} seed, bot, audit, or manual-test accounts remain; ${flagged} are flagged is_internal_test. Public stats only skip that flag, so unmarked seed customers are still counted`,
    );

    const demoAlerts = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM surv_alerts WHERE demo`);
    const seedOrders = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM user_orders WHERE user_id IN ${REMOVAL_IDS}`,
      [REMOVAL_EMAILS],
    );
    const play = await pool.query<{ n: number }>(
      `SELECT
         (SELECT count(*) FROM play_balances) + (SELECT count(*) FROM play_orders) +
         (SELECT count(*) FROM play_trades) + (SELECT count(*) FROM play_moves) AS n`,
    );
    const paper = await pool.query<{ n: number }>(
      `SELECT
         (SELECT count(*) FROM paper_wallets) + (SELECT count(*) FROM paper_orders) +
         (SELECT count(*) FROM paper_trades) AS n`,
    );
    const ann = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM announcements WHERE id = ANY($1::text[]) OR title = ANY($2::text[])`,
      [SEED_CONTENT.announcements, SEED_CONTENT.announcementTitles],
    );
    const camp = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM campaigns WHERE id = ANY($1::text[])`,
      [SEED_CONTENT.campaigns],
    );
    const help = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM help_articles WHERE id = ANY($1::text[])`,
      [SEED_CONTENT.help],
    );
    const seedBits = [
      Number(demoAlerts.rows[0].n) > 0 ? `${demoAlerts.rows[0].n} bot surveillance alerts` : "",
      Number(seedOrders.rows[0].n) > 0 ? `${seedOrders.rows[0].n} orders on seed accounts` : "",
      Number(play.rows[0].n) > 0 ? `${play.rows[0].n} play-ledger rows` : "",
      Number(paper.rows[0].n) > 0 ? `${paper.rows[0].n} paper-trading rows` : "",
      Number(ann.rows[0].n) > 0 ? `${ann.rows[0].n} seed announcements` : "",
      Number(camp.rows[0].n) > 0 ? `${camp.rows[0].n} seed campaigns` : "",
      Number(help.rows[0].n) > 0 ? `${help.rows[0].n} seed help articles` : "",
    ].filter(Boolean);
    push(
      "demo_seed_data",
      seedBits.length === 0 ? "PASS" : "FAIL",
      seedBits.length === 0 ? "seed orders, play ledgers, and sample content are absent" : seedBits.join("; "),
    );

    const files = fs
      .readdirSync(path.join(root, "db/migrations"))
      .filter((name) => name.endsWith(".sql"))
      .map((name) => name.replace(/\.sql$/, ""))
      .sort();
    const applied = await pool.query<{ id: string }>(`SELECT id FROM schema_migrations`);
    const have = new Set(applied.rows.map((row) => row.id));
    const missing = files.filter((id) => !have.has(id));
    push(
      "migrations_current",
      missing.length === 0 ? "PASS" : "FAIL",
      missing.length === 0
        ? `${files.length} migrations applied, through ${files[files.length - 1]}`
        : `not applied: ${missing.join(", ")}`,
    );

    const poolRows = await pool.query<{ address: string; status: string }>(
      `SELECT address, status FROM address_pool`,
    );
    const generated = sandboxAddresses();
    const seeded = poolRows.rows.filter((row) => generated.has(normalizeAddress(row.address)));
    const verified = process.env.MERIDEX_POOL_VERIFIED === "1" || env.MERIDEX_POOL_VERIFIED === "1";
    let poolStatus: Status = "FAIL";
    let poolDetail = "";
    if (poolRows.rows.length === 0) poolDetail = "address pool is empty";
    else if (seeded.length > 0) {
      poolDetail = `${seeded.length} of ${poolRows.rows.length} addresses match the sandbox generator; owner verification is not accepted while those remain`;
    } else if (!verified) {
      poolDetail = `${poolRows.rows.length} addresses are not sandbox-generated, and MERIDEX_POOL_VERIFIED is not 1`;
    } else {
      poolStatus = "PASS";
      poolDetail = `${poolRows.rows.length} owner-imported addresses and MERIDEX_POOL_VERIFIED=1`;
    }
    push("address_pool_verified", poolStatus, poolDetail);

    const params = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM business_params ORDER BY key`,
    );
    const fees = await pool.query<{ vip_tier: string; maker_bps: number; taker_bps: number }>(
      `SELECT vip_tier, maker_bps, taker_bps FROM fee_schedules ORDER BY vip_tier`,
    );
    const reviewed = process.env.MERIDEX_PARAMS_REVIEWED === "1" || env.MERIDEX_PARAMS_REVIEWED === "1";
    const paramText = params.rows.map((row) => `${row.key}=${row.value}`).join(", ") || "no business_params rows";
    const feeText = fees.rows.map((row) => `${row.vip_tier} ${row.maker_bps}/${row.taker_bps} bps`).join(", ") || "no fee_schedules";
    push(
      "params_reviewed",
      reviewed ? "PASS" : "FAIL",
      reviewed
        ? `MERIDEX_PARAMS_REVIEWED=1 (${paramText})`
        : `no owner sign-off. Stored params: ${paramText}. Fee table: ${feeText}. Code defaults still apply to every fee key that is not stored`,
    );
  } finally {
    await pool.end();
  }

  const envBlob = Object.values(env).join("\n") + "\n" + Object.values(process.env).join("\n");
  const envSecret =
    PASSWORDS.some((item) => envBlob.includes(item)) ||
    TOTP_SEEDS.some((item) => envBlob.includes(item)) ||
    envBlob.includes(JWT_DEFAULT) ||
    (env.DATABASE_URL ?? process.env.DATABASE_URL ?? "").includes(DB_DEFAULT);
  push(
    "env_sandbox_secrets",
    envSecret ? "FAIL" : "PASS",
    envSecret
      ? "gateway or process environment still carries the sandbox JWT, database password, or a published seed"
      : "live environment does not contain the published sandbox secrets",
  );

  const hits: string[] = [];
  walk(root, hits);
  push(
    "repo_secrets",
    hits.length === 0 ? "PASS" : "FAIL",
    hits.length === 0
      ? "published passwords, TOTP seeds, the sandbox JWT, and the sandbox database URL are not in the tree"
      : `${hits.length} files still contain a published password, TOTP seed, sandbox JWT, or sandbox database URL. Examples: ${hits.slice(0, 8).join(", ")}`,
  );

  const server = readText("gateway/src/server.ts");
  const platformRoutes = readText("gateway/src/platformRoutes.ts");
  const geo = readText("gateway/src/geo.ts");
  const start = readText("start-meridex.sh");
  const defaults: string[] = [];
  if (server.includes('JWT_SECRET ?? "') || platformRoutes.includes('JWT_SECRET ?? "')) defaults.push("JWT fallback in gateway code");
  if (server.includes('DATABASE_URL ?? "postgres://meridex:meridex')) defaults.push("database URL fallback");
  if (server.includes('SEED_DEMO !== "0"')) defaults.push("SEED_DEMO defaults on");
  if (geo.includes('SANDBOX_MOCK_GEO !== "0"')) defaults.push("mock geo defaults on");
  if (server.includes('BOTS !== "0"')) defaults.push("BOTS defaults on");
  if (start.includes("SEED_DEMO:-1") || start.includes("JWT_SECRET:-meridex-sandbox")) defaults.push("start-meridex.sh injects sandbox defaults");
  push(
    "sandbox_code_defaults",
    defaults.length === 0 ? "PASS" : "FAIL",
    defaults.length === 0 ? "gateway and start script do not default sandbox secrets or seed flags on" : defaults.join("; "),
  );

  const seedOn = (env.SEED_DEMO ?? "1") !== "0";
  const botsOn = (env.BOTS ?? "1") !== "0";
  const mockGeo = (env.SANDBOX_MOCK_GEO ?? "1") !== "0";
  push(
    "sandbox_flags",
    gateway && !seedOn && !botsOn && !mockGeo ? "PASS" : "FAIL",
    !gateway
      ? "gateway process not found, so live SEED_DEMO, BOTS, and SANDBOX_MOCK_GEO could not be read"
      : `pid ${gateway.pid}: SEED_DEMO=${env.SEED_DEMO ?? "unset"} BOTS=${env.BOTS ?? "unset"} SANDBOX_MOCK_GEO=${env.SANDBOX_MOCK_GEO ?? "unset"}`,
  );

  const cookies = cookieLiterals(server);
  const httpOnly = cookies.length >= 3 && cookies.every((line) => line.includes("HttpOnly"));
  const sameSite = cookies.length >= 3 && cookies.every((line) => /SameSite=(Lax|Strict)/.test(line));
  const secure = cookies.length >= 3 && cookies.every((line) => /;\s*Secure/.test(line) || line.includes("; Secure"));
  push("cookie_httponly", httpOnly ? "PASS" : "FAIL", httpOnly ? "session cookies set HttpOnly" : "a session cookie is missing HttpOnly");
  push(
    "cookie_samesite",
    sameSite ? "PASS" : "FAIL",
    sameSite ? "session cookies set SameSite=Lax or Strict" : "a session cookie is missing SameSite",
  );
  push(
    "cookie_secure",
    secure ? "PASS" : "FAIL",
    secure
      ? "session cookies set Secure"
      : "session cookies omit Secure. Leave it off while the sandbox is plain HTTP; set it only behind the TLS proxy",
  );
  const corsOpen = server.includes("origin: true");
  const csrfLocal = server.includes('host !== "localhost"') && server.includes('host !== "127.0.0.1"');
  push(
    "cors_and_origin",
    !corsOpen && !csrfLocal ? "PASS" : "FAIL",
    corsOpen
      ? "CORS reflects any origin, and CSRF allows only localhost and 127.0.0.1. Production needs an explicit origin list for the customer, admin, and desk hosts"
      : "CORS is not reflect-any and CSRF is not limited to loopback",
  );
  const allow = (env.ADMIN_IP_ALLOWLIST ?? process.env.ADMIN_IP_ALLOWLIST ?? "").trim();
  push(
    "admin_ip_allowlist",
    allow ? "PASS" : "FAIL",
    allow ? "ADMIN_IP_ALLOWLIST is set on the gateway" : "ADMIN_IP_ALLOWLIST is empty, so admin routes are not IP-restricted",
  );

  const rateSrc = server + "\n" + platformRoutes;
  const rateKeys = ["reg:", "login:", "wd:", "alert:", "paper:", "ord:", "v1:"];
  const missingRates = rateKeys.filter((key) => !rateSrc.includes(`\`${key}`) && !rateSrc.includes(key));
  push(
    "rate_limits",
    missingRates.length === 0 ? "PASS" : "FAIL",
    missingRates.length === 0
      ? "rate limits exist on register, login, withdraw, alerts, paper, orders, and v1. The numbers are sandbox values, not a production tuning review"
      : `missing rate-limit keys: ${missingRates.join(", ")}`,
  );

  const publicUrls = ["CUSTOMER_PUBLIC_URL", "ADMIN_PUBLIC_URL", "POOL_PUBLIC_URL"].map((name) => {
    const value = env[name] || process.env[name] || "";
    return `${name}=${value || "unset"}`;
  });
  const tlsOk = ["CUSTOMER_PUBLIC_URL", "ADMIN_PUBLIC_URL", "POOL_PUBLIC_URL"].every((name) =>
    (env[name] || process.env[name] || "").startsWith("https://"),
  );
  push(
    "tls_public_urls",
    tlsOk ? "PASS" : "FAIL",
    tlsOk ? publicUrls.join(" ") : `${publicUrls.join(" ")}. TLS is expected at the reverse proxy; these URLs are not https`,
  );
  const host = env.GATEWAY_HOST || process.env.GATEWAY_HOST || "";
  push(
    "loopback_bind",
    host === "127.0.0.1" || host === "localhost" ? "PASS" : "FAIL",
    host ? `GATEWAY_HOST=${host}` : "GATEWAY_HOST is unset",
  );

  const dir = backupDir();
  let dumpOk = false;
  let dumpDetail = `no ${dir}/latest.json`;
  try {
    const latest = JSON.parse(fs.readFileSync(path.join(dir, "latest.json"), "utf8")) as {
      ok?: boolean;
      file?: string;
      bytes?: number;
      at?: string;
    };
    dumpOk = !!latest.ok && !!latest.file && fs.existsSync(latest.file) && Number(latest.bytes) > 0;
    dumpDetail = dumpOk
      ? `local dump ${latest.at} ${latest.bytes} bytes`
      : `latest.json is not a usable dump (${latest.at ?? "no time"})`;
  } catch {
    dumpOk = false;
  }
  push("backup_dump", dumpOk ? "PASS" : "FAIL", dumpDetail);
  const scheduled = scheduledBackup();
  push(
    "backup_schedule",
    scheduled ? "PASS" : "FAIL",
    scheduled
      ? "a cron or systemd unit references backup-db.sh"
      : "backup-db.sh is not scheduled. scripts/com.meridex.backup.plist is a template with /Users/YOU paths and is not installed",
  );
  const offsite = (env.MERIDEX_BACKUP_OFFSITE || process.env.MERIDEX_BACKUP_OFFSITE || "").trim();
  push(
    "backup_offsite",
    offsite ? "PASS" : "FAIL",
    offsite ? "MERIDEX_BACKUP_OFFSITE is set" : "MERIDEX_BACKUP_OFFSITE is unset; dumps stay on this machine",
  );
  let restoreOk = false;
  let restoreDetail = "no restore-tested.json from a scratch restore drill";
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dir, "restore-tested.json"), "utf8")) as { ok?: boolean; at?: string };
    restoreOk = marker.ok === true && !!marker.at;
    restoreDetail = restoreOk ? `restore drill recorded at ${marker.at}` : "restore-tested.json is present but not ok";
  } catch {
    restoreOk = false;
  }
  push("backup_restore_tested", restoreOk ? "PASS" : "FAIL", restoreDetail);

  try {
    const health = (await fetchJson("http://127.0.0.1:7108/healthz")) as {
      ok?: boolean;
      halted?: boolean;
      feeds?: { ok?: boolean; lastError?: string | null; candles?: { source?: string; lastError?: string | null } };
    };
    const candleError = health.feeds?.candles?.lastError;
    const feedError = health.feeds?.lastError;
    const healthy = !!health.ok && !health.halted && !!health.feeds?.ok && !feedError && !candleError;
    push(
      "feeds_healthy",
      healthy ? "PASS" : "FAIL",
      healthy
        ? "healthz feeds.ok with no lastError"
        : `healthz ok=${health.ok} halted=${health.halted} feeds.ok=${health.feeds?.ok} lastError=${feedError ?? "none"} candles=${health.feeds?.candles?.source ?? "unknown"} candles.lastError=${candleError ?? "none"}`,
    );
  } catch (err) {
    push("feeds_healthy", "FAIL", `gateway /healthz unreachable (${err instanceof Error ? err.message : "error"})`);
  }

  const fails = rows.filter((row) => row.status === "FAIL").length;
  console.log("prelaunch-check  local sandbox  read-only  no deploy");
  const width = Math.max(...rows.map((row) => row.id.length));
  for (const row of rows) console.log(`${row.status}  ${row.id.padEnd(width)}  ${row.detail}`);
  console.log(`result ${fails === 0 ? "PASS" : "FAIL"}  pass=${rows.length - fails}  fail=${fails}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
