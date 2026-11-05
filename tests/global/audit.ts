/**
 * Live audit of the local sandbox. Writes /tmp/global-audit.json.
 * Does not print secrets. Restarts the engine and gateway at the end and brings them back.
 */
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { totp } from "../../gateway/src/crypto.js";

const require = createRequire(import.meta.url);
const puppeteer = require("/tmp/audit-deps/node_modules/puppeteer-core") as {
  launch: (opts: Record<string, unknown>) => Promise<{
    newPage: () => Promise<Page>;
    close: () => Promise<void>;
  }>;
};

type Page = {
  goto: (url: string, opts?: Record<string, unknown>) => Promise<unknown>;
  setViewport: (v: { width: number; height: number }) => Promise<void>;
  evaluate: <T>(fn: (...args: never[]) => T, ...args: unknown[]) => Promise<T>;
  $eval: (sel: string, fn: (el: Element) => string | null) => Promise<string | null>;
  $$eval: (sel: string, fn: (els: Element[]) => unknown) => Promise<unknown>;
  waitForSelector: (sel: string, opts?: Record<string, unknown>) => Promise<unknown>;
  select: (sel: string, value: string) => Promise<unknown>;
  click: (sel: string) => Promise<void>;
  url: () => string;
  on: (ev: string, fn: (arg: { type?: () => string; text?: () => string; message?: string }) => void) => void;
  close: () => Promise<void>;
};

const GW = "http://127.0.0.1:7108";
const CUSTOMER = "http://127.0.0.1:4317";
const ADMIN = "http://127.0.0.1:4318";
const POOL = "http://127.0.0.1:4319";

const ACCOUNTS = {
  demo: ["client@meridexexchange.com", "<redacted>", "<redacted>"],
  compliance: ["compliance@meridexexchange.com", "<redacted>", "<redacted>"],
  owner: ["founder@meridexexchange.com", "<redacted>", "<redacted>"],
  support: ["support@meridexexchange.com", "<redacted>", "<redacted>"],
  risk: ["risk@meridexexchange.com", "<redacted>", "<redacted>"],
  ops: ["ops@meridexexchange.com", "<redacted>", "<redacted>"],
  checker: ["ops.checker@meridexexchange.com", "<redacted>", "<redacted>"],
} as const;

type Sev = "high" | "med" | "low";
type Issue = { severity: Sev; page: string; steps: string; expected: string; actual: string; fix: string };
const issues: Issue[] = [];
const passed: string[] = [];

function pass(name: string) {
  passed.push(name);
}

function issue(severity: Sev, page: string, steps: string, expected: string, actual: string, fix: string) {
  issues.push({ severity, page, steps, expected, actual, fix });
  console.log(`ISSUE ${severity} ${page}: ${actual}`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

type Body = Record<string, unknown> & { error?: string; token?: string; role?: string };

async function call(path: string, init: RequestInit = {}, headers: Record<string, string> = {}) {
  const res = await fetch(`${GW}${path}`, {
    ...init,
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...headers },
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  let data: Body = {};
  try {
    data = text ? (JSON.parse(text) as Body) : {};
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { status: res.status, data };
}

async function login(who: keyof typeof ACCOUNTS, portal: "customer" | "staff" | "pool" = "customer") {
  const [email, password, secret] = ACCOUNTS[who];
  const path = portal === "staff" ? "/api/admin/auth/login" : portal === "pool" ? "/api/pool/auth/login" : "/api/auth/login";
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(400);
    const res = await call(path, { method: "POST", body: JSON.stringify({ email, password, totp: totp(secret) }) }, { "x-mock-country": "SG" });
    if (res.status === 429) {
      await sleep(1500);
      continue;
    }
    return res;
  }
  return { status: 429, data: { error: "RATE_LIMITED" } as Body };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

function listeners() {
  const rows: { ip: string; port: number }[] = [];
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.trim().split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols[3] !== "0A") continue;
      const [ipHex, portHex] = cols[1].split(":");
      const n = Number.parseInt(ipHex, 16);
      const ip = file.endsWith("6")
        ? ipHex
        : [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255].join(".");
      rows.push({ ip, port: Number.parseInt(portHex, 16) });
    }
  }
  return rows;
}

async function pageStatus(url: string) {
  const started = Date.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  return { status: res.status, ms: Date.now() - started, text };
}

const CUSTOMER_PAGES = [
  "/", "/markets", "/terminal", "/funds", "/funds/deposit", "/funds/withdraw", "/funds/history",
  "/portfolio", "/account", "/account/security", "/account/preferences", "/account/notifications",
  "/account/referral", "/account/api", "/kyc", "/login", "/register", "/support", "/help", "/inbox",
  "/rewards", "/developers", "/fees", "/risk", "/terms", "/convert", "/recurring", "/margin",
  "/perps", "/copy", "/offline", "/markets/BTC%2FUSD", "/markets/XAUKG%2FUSD",
];
const ADMIN_PAGES = ["/", "/login", "/compliance", "/surveillance", "/ops", "/ops/reports", "/support", "/content", "/treasury", "/security", "/internal", "/outbox", "/funds", "/liquidity", "/customers", "/deposits", "/deposits/reconcile", "/withdrawals"];
const POOL_PAGES = ["/", "/login"];

async function httpPages() {
  for (const [base, pages] of [[CUSTOMER, CUSTOMER_PAGES], [ADMIN, ADMIN_PAGES], [POOL, POOL_PAGES]] as const) {
    for (const path of pages) {
      try {
        const res = await pageStatus(base + path);
        const name = `${base.includes("4317") ? "customer" : base.includes("4318") ? "admin" : "pool"} ${path}`;
        if (res.status !== 200) issue("high", name, `GET ${path}`, "HTTP 200", `HTTP ${res.status}`, "Fix the route or the server error.");
        else if (res.ms > 4000) issue("low", name, `GET ${path}`, "under 4s", `${res.ms}ms`, "Look at the slow render or the API it waits on.");
        else pass(name);
        if (res.status === 200 && /Application error|Internal Server Error/i.test(res.text)) {
          issue("high", name, `GET ${path}`, "rendered page", "error shell", "Read the server log for the exception.");
        }
      } catch (err) {
        issue("high", path, `GET ${path}`, "HTTP 200", String(err), "Restart the site process.");
      }
    }
  }
}

async function securityAndAuth() {
  const open = listeners();
  for (const port of [4317, 4318, 4319, 7108, 7109]) {
    const hits = open.filter((row) => row.port === port);
    const local = hits.some((row) => row.ip === "127.0.0.1" || row.ip === "00000000000000000000000001000000");
    const wild = hits.some((row) => row.ip === "0.0.0.0" || row.ip === "00000000000000000000000000000000");
    if (!hits.length) issue("high", `:${port}`, "read /proc/net/tcp", "listening on 127.0.0.1", "not listening", "Start the process with the local bind.");
    else if (wild) issue("med", `:${port}`, "read /proc/net/tcp", "127.0.0.1 only", `bound ${hits.map((h) => h.ip).join(",")}`, "Set HOST / ADMIN_HOST / POOL_HOST / GATEWAY_HOST / ENGINE_BIND back to 127.0.0.1.");
    else if (local) pass(`bind :${port}`);
    else issue("med", `:${port}`, "read /proc/net/tcp", "127.0.0.1", hits.map((h) => h.ip).join(","), "Bind the listener to loopback.");
  }
  const pg = open.filter((row) => row.port === 5432);
  if (pg.some((row) => row.ip === "0.0.0.0" || row.ip === "00000000000000000000000000000000")) {
    issue("low", "postgres:5432", "read /proc/net/tcp", "loopback only", `bound ${pg.map((h) => h.ip).join(",")}`, "Set listen_addresses=localhost in postgresql.conf. The sandbox password is public.");
  } else pass("postgres bind");

  const me = await call("/api/me");
  if (me.status === 401) pass("anonymous /api/me");
  else issue("high", "/api/me", "GET without a token", "401", `${me.status} ${me.data.error}`, "Require a session.");

  const csrf = await call("/api/auth/login", { method: "POST", body: JSON.stringify({ email: "a@b.co", password: "x", totp: "000000" }) }, { origin: "https://evil.example" });
  if (csrf.status === 403 && csrf.data.error === "CSRF_ORIGIN") pass("csrf origin");
  else issue("high", "gateway", "POST /api/auth/login with Origin https://evil.example", "403 CSRF_ORIGIN", `${csrf.status} ${csrf.data.error}`, "Keep the origin hook in front of writes.");

  const badEmail = await call("/api/auth/register", { method: "POST", body: JSON.stringify({ email: "not-an-email", password: "<redacted>" }) });
  if (badEmail.status === 400) pass("register validation");
  else issue("med", "/register", "POST a non-email", "400", `${badEmail.status}`, "Reject it in the zod schema.");

  const weak = await call("/api/auth/register", { method: "POST", body: JSON.stringify({ email: `weak-${Date.now()}@meridexexchange.com`, password: "password" }) });
  if (weak.status === 400 && (weak.data.error === "WEAK_PASSWORD" || weak.data.error === "VALIDATION")) pass("weak password");
  else issue("med", "/register", "POST password 'password'", "400 WEAK_PASSWORD", `${weak.status} ${weak.data.error}`, "Keep assertPassword.");

  const blocked = await call("/api/auth/register", { method: "POST", body: JSON.stringify({ email: `kp-${Date.now()}@meridexexchange.com`, password: "<redacted>", residenceCountry: "KP" }) });
  if (blocked.status === 403) pass("sanctioned residence");
  else issue("high", "/register", "Register with residence KP", "403", `${blocked.status} ${blocked.data.error}`, "Hard-close sanctioned residences.");

  let limited = false;
  for (let i = 0; i < 20; i++) {
    const res = await call("/api/alerts", { method: "POST", body: "{}" });
    if (res.status === 429) {
      limited = true;
      break;
    }
  }
  if (limited) pass("alert rate limit");
  else issue("med", "POST /api/alerts", "20 immediate posts", "429 RATE_LIMITED", "no 429", "The token bucket is not applied before the handler returns.");

  const staffOnCustomer = await login("owner", "customer");
  if (staffOnCustomer.data.error === "STAFF_PORTAL") pass("staff blocked on customer login");
  else issue("high", "/login", "Founder logs in on the customer portal", "403 STAFF_PORTAL", `${staffOnCustomer.status} ${staffOnCustomer.data.error}`, "Keep the portal split.");

  const customerOnStaff = await login("demo", "staff");
  if (customerOnStaff.data.error === "CUSTOMER_PORTAL") pass("customer blocked on admin login");
  else issue("high", "admin /login", "Demo customer logs in on 4318", "403 CUSTOMER_PORTAL", `${customerOnStaff.status} ${customerOnStaff.data.error}`, "Keep the portal split.");

  const customerOnPool = await login("demo", "pool");
  if (customerOnPool.status === 403) pass("customer blocked on pool login");
  else issue("high", "pool /login", "Demo customer logs in on 4319", "403", `${customerOnPool.status} ${customerOnPool.data.error}`, "Pool login is owner-only.");

  const supportOnPool = await login("support", "pool");
  if (supportOnPool.data.error === "NOT_POOL_OWNER") pass("support blocked on pool login");
  else issue("high", "pool /login", "Support logs in on 4319", "403 NOT_POOL_OWNER", `${supportOnPool.status} ${supportOnPool.data.error}`, "assertPoolOwner on the pool portal.");

  return {
    demo: await login("demo"),
    owner: await login("owner", "staff"),
    ownerPool: await login("owner", "pool"),
    support: await login("support", "staff"),
    risk: await login("risk", "staff"),
    ops: await login("ops", "staff"),
    compliance: await login("compliance", "staff"),
  };
}

async function flows(tokens: Record<string, { status: number; data: Body }>) {
  const demo = tokens.demo.data.token;
  const owner = tokens.owner.data.token;
  const pool = tokens.ownerPool.data.token;
  const support = tokens.support.data.token;
  const risk = tokens.risk.data.token;
  const ops = tokens.ops.data.token;
  if (!demo || !owner || !pool) {
    issue("high", "login", "Log in demo, founder staff, founder pool", "tokens", `demo=${tokens.demo.status} owner=${tokens.owner.status} pool=${tokens.ownerPool.status}`, "Check seeds and TOTP.");
    return;
  }

  const me = await call("/api/me", {}, auth(demo));
  if (me.status === 200) pass("customer /api/me");
  else issue("high", "/account", "GET /api/me as demo", "200", `${me.status} ${me.data.error}`, "Session verification.");

  const stamp = Date.now();
  const email = `audit-${stamp}@meridexexchange.com`;
  const registered = await call("/api/auth/register", { method: "POST", body: JSON.stringify({ email, password: "<redacted>", residenceCountry: "SG" }) });
  const secret = String(registered.data.totpSecret ?? "");
  if (registered.status !== 200 || !secret) {
    issue("high", "/register", "Register a new SG customer", "200 and a totp secret", `${registered.status} ${registered.data.error}`, "Register handler.");
  } else {
    await sleep(400);
    const fresh = await call("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password: "<redacted>", totp: totp(secret) }) });
    if (!fresh.data.token) issue("high", "/login", "Log in the new account", "token", `${fresh.status} ${fresh.data.error}`, "Login after register.");
    else {
      const kyc = await call("/api/kyc", { method: "POST", body: JSON.stringify({ nationality: "SG", residenceCountry: "SG", sanctionsHit: false }) }, auth(fresh.data.token));
      if (kyc.status === 200 && kyc.data.status === "approved") pass("register login kyc");
      else issue("med", "/kyc", "POST SG KYC with sanctionsHit false", "approved", `${kyc.status} ${JSON.stringify(kyc.data).slice(0, 160)}`, "decideKyc.");
      const sanctioned = await call("/api/kyc", { method: "POST", body: JSON.stringify({ nationality: "SG", residenceCountry: "SG", sanctionsHit: true }) }, auth(fresh.data.token));
      if (sanctioned.data.status === "rejected" || sanctioned.status === 403) pass("sanctions kyc");
      else issue("high", "/kyc", "POST sanctionsHit true", "rejected", `${sanctioned.status} ${JSON.stringify(sanctioned.data).slice(0, 160)}`, "Sanctions must not approve.");
    }
  }

  const before = await call("/api/balances", {}, auth(demo));
  const usdBefore = usdOf(before.data);
  const deposited = await call("/api/wallet/deposit", { method: "POST", body: JSON.stringify({ asset: "USD", amount: "1.00" }) }, auth(demo));
  const usdAfter = usdOf(deposited.data.balances ? { balances: deposited.data.balances } : deposited.data);
  if (deposited.status === 200 && usdAfter - usdBefore === 1_000_000n) pass("deposit 1.00 USD");
  else issue("high", "/funds/deposit", "Deposit 1.00 USD as demo", "available increases by 1000000 micro-USD", `${deposited.status} delta=${(usdAfter - usdBefore).toString()} ${deposited.data.error ?? ""}`, "Check deposit fee and the integer scale.");
  if (deposited.status === 200) {
    const back = await call("/api/wallet/withdraw", { method: "POST", body: JSON.stringify({ asset: "USD", amount: "1.00", stepUp: totp(ACCOUNTS.demo[2]) }) }, auth(demo));
    if (back.status === 200 && back.data.status === "pending") {
      const approved = await call(`/api/admin/withdrawals/${back.data.id}/approve`, { method: "POST", body: JSON.stringify({ totp: totp(ACCOUNTS.owner[2]) }) }, auth(owner));
      if (approved.status === 200) pass("withdraw restored 1.00");
      else issue("med", "/withdrawals", "Approve the queued 1.00 with the owner authenticator", "200", `${approved.status} ${approved.data.error}`, "The default review threshold queues every withdrawal. Approve it so the round trip settles.");
    } else if (back.status === 200) pass("withdraw restored 1.00");
    else issue("med", "/funds/withdraw", "Withdraw the 1.00 just deposited, with step-up", "200", `${back.status} ${back.data.error}`, "Step-up or fee left the balance short. Restore it from the ledger if the deposit stuck.");
  }

  const quote = await call("/api/convert/quote", { method: "POST", body: JSON.stringify({ symbol: "BTC/USD", side: "buy", quantity: "0.001" }) }, auth(demo));
  const notional = String(quote.data.notionalUusd ?? "");
  const fee = String(quote.data.feeUusd ?? "");
  const bps = Number(quote.data.feeBps);
  if (quote.status === 200 && /^\d+$/.test(notional) && /^\d+$/.test(fee)) {
    const expectFee = (BigInt(notional) * BigInt(bps)) / 10_000n;
    if (expectFee === BigInt(fee)) pass(`convert fee ${bps} bps integer`);
    else issue("high", "/convert", "Quote BTC/USD 0.001", `fee = notional * ${bps} / 10000`, `notional=${notional} fee=${fee}`, "Integer fee division drifted.");
  } else issue("med", "/convert", "Quote BTC/USD 0.001", "integer notional and fee", `${quote.status} ${quote.data.error ?? JSON.stringify(quote.data).slice(0, 180)}`, "Quote path.");

  const book = await call("/api/market/book?symbol=ETH/USD");
  const bid = firstPx(book.data, "bids");
  if (book.status === 200 && bid > 0n) {
    const tick = BigInt(Number(book.data.tickSize ?? 1)) || 1n;
    const limit = bid - (bid % tick === 0n ? tick : bid % tick);
    const order = await call("/api/orders", { method: "POST", body: JSON.stringify({ symbol: "ETH/USD", side: "buy", type: "limit", price: formatPx(limit, book.data), quantity: "0.01", timeInForce: "gtc" }) }, auth(demo));
    const id = String(order.data.orderId ?? (order.data.order as { id?: string } | undefined)?.id ?? order.data.id ?? "");
    if (order.status === 200 && id) {
      const cancel = await call(`/api/orders/${id}/cancel`, { method: "POST", body: "{}" }, auth(demo));
      if (cancel.status === 200) pass("resting ETH limit then cancel");
      else issue("med", "/terminal", `Cancel order ${id}`, "200", `${cancel.status} ${cancel.data.error}`, "Cancel must release the reserve.");
    } else if (order.data.error === "PRICE_BAND" || order.data.error === "INSUFFICIENT_FUNDS") {
      pass(`order rejected cleanly ${order.data.error}`);
    } else issue("med", "/terminal", "Buy ETH/USD one tick under the bid", "accepted or a known rejection", `${order.status} ${order.data.error}`, "Order path.");
  } else issue("med", "/terminal", "GET /api/market/book?symbol=ETH/USD", "a bid", `${book.status}`, "Engine book.");

  const chat = await call("/api/support/chat", { method: "POST", body: JSON.stringify({ body: "Global audit ping. No payment instruction." }) }, auth(demo));
  if (chat.status === 200) pass("customer chat");
  else issue("med", "/support", "POST a plain chat line", "200", `${chat.status} ${chat.data.error}`, "Concierge post.");

  const inv = await call("/api/admin/invariants", {}, auth(owner));
  const checks = (inv.data.checks as { name: string; ok: boolean; detail: string }[] | undefined) ?? [];
  if (inv.status === 200 && inv.data.ok === true) pass("ledger invariants");
  else issue("high", "/compliance", "GET /api/admin/invariants", "ok true", `${inv.status} ${checks.filter((c) => !c.ok).map((c) => c.name + " " + c.detail).join(" | ") || inv.data.error}`, "Repair the unbalanced asset before any further money movement.");

  const reports = await call("/api/admin/ops/reports", {}, auth(owner));
  const internal = await call("/api/admin/internal-test", {}, auth(owner));
  const accounts = (internal.data.accounts as { email?: string }[] | undefined) ?? [];
  if (internal.status === 200) pass("internal test list");
  else issue("high", "/internal", "GET /api/admin/internal-test as founder", "200", `${internal.status} ${internal.data.error}`, "superAdmin gate.");
  for (const row of accounts) {
    if (!row.email) continue;
    const found = await call(`/api/admin/ops/users?q=${encodeURIComponent(row.email)}`, {}, auth(owner));
    const users = (found.data.users as { email?: string }[] | undefined) ?? [];
    if (users.some((u) => u.email === row.email)) {
      issue("high", "/ops", `Search ops users for ${row.email}`, "excluded", "present", "searchUsers must keep is_internal_test = false.");
    }
  }
  if (accounts.length) pass("internal emails excluded from ops search");
  const blob = JSON.stringify(reports.data);
  if (reports.status === 200 && !accounts.some((row) => row.email && blob.includes(row.email))) pass("reports omit internal emails");
  else if (reports.status !== 200) issue("med", "/ops/reports", "GET reports as founder", "200", `${reports.status} ${reports.data.error}`, "reports().");

  const supportInternal = await call("/api/admin/internal-test", {}, auth(support || ""));
  if (supportInternal.status === 403) pass("support cannot open internal test");
  else issue("high", "/internal", "Support GET /api/admin/internal-test", "403", `${supportInternal.status}`, "Restrict to the super-admin.");

  const riskHalt = await call("/api/admin/halt", { method: "POST", body: JSON.stringify({ symbol: "XAU/USD" }) }, auth(risk || ""));
  if (riskHalt.status === 403) pass("risk cannot halt");
  else issue("high", "/compliance", "Risk POST /api/admin/halt", "403", `${riskHalt.status} ${riskHalt.data.error}`, "Halt stays with admin. Resume the book if this call halted it.");

  const opsContent = await call("/api/admin/content/number", { method: "PUT", body: JSON.stringify({ key: "fee.standard.makerBps", value: 1 }) }, auth(ops || ""));
  if (opsContent.status === 403) pass("ops cannot edit content");
  else issue("high", "/content", "Ops PUT a fee", "403", `${opsContent.status}`, "Content writes are admin-only. Reset the fee if it changed.");

  const badFee = await call("/api/admin/content/number", { method: "PUT", body: JSON.stringify({ key: "fee.standard.makerBps", value: 9999 }) }, auth(owner));
  if (badFee.status === 400 && badFee.data.error === "VALIDATION") pass("fee out of range");
  else issue("med", "/content", "PUT maker fee 9999", "400 VALIDATION", `${badFee.status} ${badFee.data.error}`, "checkNumber min/max.");

  const desk = await call("/api/admin/treasury/pool/import", { method: "POST", body: JSON.stringify({ csv: "BTC,bitcoin,bc1qexample" }) }, auth(owner));
  if (desk.status === 403 && desk.data.error === "POOL_DESK") pass("admin cannot import addresses");
  else issue("high", "/treasury", "Founder POST /api/admin/treasury/pool/import", "403 POOL_DESK", `${desk.status} ${desk.data.error}`, "Address writes belong on 4319.");

  const noTotp = await call("/api/pool/treasury/pool/import", { method: "POST", body: JSON.stringify({ rows: [] }) }, auth(pool));
  if (noTotp.status === 401 && noTotp.data.error === "TOTP_REQUIRED") pass("pool write needs totp");
  else issue("high", "4319", "Import with no totp", "401 TOTP_REQUIRED", `${noTotp.status} ${noTotp.data.error}`, "requireFreshTotp before any write. Do not send a wrong code; five failures lock the owner.");

  for (const path of ["/api/admin/ops/overview", "/api/admin/ops/audit", "/api/admin/risk/dashboard", "/api/admin/support/queues", "/api/admin/support/inbox", "/api/admin/content", "/api/admin/content/audit", "/api/admin/treasury/pool", "/api/admin/treasury/audit", "/api/pool/treasury/pool"]) {
    const token = path.startsWith("/api/pool") ? pool : owner;
    const res = await call(path, {}, auth(token));
    if (res.status === 200) pass(path);
    else issue("med", path, `GET ${path}`, "200", `${res.status} ${res.data.error}`, "The section failed to load.");
  }

  const health = await call("/healthz");
  if (health.status === 200 && health.data.ok === true && health.data.feeds) pass("healthz feeds");
  else issue("med", "/healthz", "GET /healthz", "ok and feeds", `${health.status} ${JSON.stringify(health.data).slice(0, 180)}`, "Feed report.");

  const xssKey = "zh.heroTitle";
  const payload = `<img src=x onerror=alert(1)>`;
  const set = await call("/api/admin/content/string", { method: "PUT", body: JSON.stringify({ key: xssKey, value: payload }) }, auth(owner));
  try {
    if (set.status !== 200) issue("med", "/content", "PUT a script-like hero title", "200", `${set.status} ${set.data.error}`, "setString.");
    else {
      const pub = await call("/api/content");
      const home = await pageStatus(CUSTOMER + "/");
      const reflected = home.text.includes(payload);
      const executed = /<img src=x onerror=alert\(1\)>/.test(home.text) && !home.text.includes("&lt;img");
      if (pub.status === 200 && reflected && !executed) pass("content override is text");
      else if (!reflected) pass("content override not in the raw HTML shell");
      else issue("high", "/", "Override zh.heroTitle with an img onerror payload and open /", "rendered as text", "raw tag in HTML", "Do not inject content overrides with dangerouslySetInnerHTML.");
    }
  } finally {
    await call("/api/admin/content/string", { method: "DELETE", body: JSON.stringify({ key: xssKey }) }, auth(owner));
  }
}

function usdOf(data: Body): bigint {
  const pocket = (data.USD as { available?: string } | undefined)
    ?? ((data.balances as { USD?: { available?: string } } | undefined)?.USD);
  if (pocket?.available) return BigInt(pocket.available);
  const assets = (data.assets as { asset?: string; available?: string }[] | undefined)
    ?? ((data.balances as { assets?: { asset?: string; available?: string }[] } | undefined)?.assets)
    ?? [];
  const row = assets.find((item) => item.asset === "USD");
  return BigInt(row?.available ?? "0");
}

function firstPx(data: Body, side: "bids" | "asks"): bigint {
  const rows = (data[side] as { price?: string; price_px?: string }[] | undefined) ?? [];
  const raw = rows[0]?.price_px ?? rows[0]?.price ?? "0";
  try {
    return BigInt(String(raw).split(".")[0] || "0");
  } catch {
    return 0n;
  }
}

function formatPx(px: bigint, data: Body): string {
  const scale = Number(data.priceScale ?? data.price_scale ?? 100);
  const decimals = Number(data.priceDecimals ?? data.price_decimals ?? 2);
  const neg = px < 0n;
  const abs = neg ? -px : px;
  const div = 10n ** BigInt(Math.max(0, Math.round(Math.log10(scale || 100))));
  const whole = abs / div;
  const frac = (abs % div).toString().padStart(String(div).length - 1, "0").slice(0, decimals);
  return `${neg ? "-" : ""}${whole.toString()}${decimals ? "." + frac : ""}`;
}

async function ui() {
  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    await walk(browser, CUSTOMER, "customer", ACCOUNTS.demo, "/api/auth/login", "meridex.token", CUSTOMER_PAGES.filter((p) => !p.startsWith("/markets/")));
    await markets(browser);
    await langs(browser);
    await walk(browser, ADMIN, "admin", ACCOUNTS.owner, "/api/admin/auth/login", "meridex.staff.token", ADMIN_PAGES.filter((p) => p !== "/login"));
    await walk(browser, POOL, "pool", ACCOUNTS.owner, "/api/pool/auth/login", "meridex.pool.token", POOL_PAGES.filter((p) => p !== "/login"));
  } finally {
    await browser.close();
  }
}

async function walk(
  browser: { newPage: () => Promise<Page> },
  origin: string,
  name: string,
  account: readonly [string, string, string],
  loginPath: string,
  tokenKey: string,
  pages: string[],
) {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (err) => {
    const message = String((err as { message?: string }).message ?? err);
    if (!/favicon/i.test(message)) errors.push(message.slice(0, 180));
  });
  page.on("console", (msg) => {
    if (msg.type?.() === "error") {
      const text = msg.text?.() ?? "";
      if (!/favicon|Download the React DevTools/i.test(text)) errors.push(text.slice(0, 180));
    }
  });
  await page.goto(origin + "/login", { waitUntil: "domcontentloaded", timeout: 20000 });
  let status = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    status = await page.evaluate(async (path: string, email: string, password: string, code: string, key: string) => {
      const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, totp: code }) });
      const data = await res.json().catch(() => ({}));
      if (data.token) localStorage.setItem(key, data.token);
      return res.status;
    }, loginPath, account[0], account[1], totp(account[2]), tokenKey) as unknown as number;
    if (status === 200) break;
    await sleep(1500);
  }
  if (status !== 200) issue("high", `${name} login`, `POST ${loginPath} from the page`, "200", String(status), "The browser could not establish a session.");
  else pass(`${name} browser login`);

  for (const width of [1280, 390]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 800 });
    for (const path of pages) {
      errors.length = 0;
      try {
        await page.goto(origin + path, { waitUntil: "domcontentloaded", timeout: 20000 });
        await sleep(250);
      } catch (err) {
        issue("med", `${name} ${path}`, `Open ${path} at ${width}px`, "navigation finishes", String(err).slice(0, 160), "The page hung or the dev server refused.");
        continue;
      }
      const layout = await page.evaluate(() => {
        const doc = document.documentElement;
        const offenders: string[] = [];
        for (const el of Array.from(document.body.querySelectorAll("*"))) {
          const node = el as HTMLElement;
          if (node.scrollWidth > node.clientWidth + 32 && node.clientWidth > 40) {
            const style = getComputedStyle(node);
            if (style.overflowX === "auto" || style.overflowX === "scroll" || style.overflowX === "hidden") continue;
            offenders.push(`${node.tagName}.${String(node.className).slice(0, 40)}`);
            if (offenders.length >= 3) break;
          }
        }
        return { extra: doc.scrollWidth - doc.clientWidth, offenders, text: document.body.innerText.slice(0, 80) };
      });
      if (layout.extra > 24) {
        issue("low", `${name} ${path}`, `Open at ${width}px`, "no horizontal page scroll", `extra ${layout.extra}px ${layout.offenders.join(" ")}`, "Let the wide child scroll inside itself, or wrap it.");
      }
      const real = errors.filter((line) => !/Failed to load resource/i.test(line));
      if (real.length) issue("med", `${name} ${path}`, `Open ${path} at ${width}px`, "no console exception", real.slice(0, 2).join(" | "), "Fix the exception. Failed network lines are listed only when they are not the only noise.");
    }
  }
  await page.close();
}

async function markets(browser: { newPage: () => Promise<Page> }) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(CUSTOMER + "/login", { waitUntil: "networkidle0", timeout: 20000 });
  await page.evaluate(async (email: string, password: string, code: string) => {
    const res = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, totp: code }) });
    const data = await res.json();
    if (data.token) localStorage.setItem("meridex.token", data.token);
  }, ACCOUNTS.demo[0], ACCOUNTS.demo[1], totp(ACCOUNTS.demo[2]));
  await page.goto(CUSTOMER + "/markets", { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector("a[data-symbol]", { timeout: 10000 });
  const symbols = await page.$$eval("a[data-symbol]", (els) => els.map((el) => el.getAttribute("data-symbol")).filter((v): v is string => Boolean(v)));
  let bad = 0;
  for (const sym of symbols as string[]) {
    await page.goto(`${CUSTOMER}/terminal?symbol=${encodeURIComponent(sym)}`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForSelector("strong[data-symbol]", { timeout: 10000 });
    await sleep(400);
    const shown = await page.$eval("strong[data-symbol]", (el) => el.getAttribute("data-symbol"));
    if (shown !== sym) {
      bad += 1;
      issue("high", "/markets", `Open ${sym} from the markets list`, shown ?? "", sym, "The URL symbol must win over localStorage.");
    }
  }
  if (!bad && (symbols as string[]).length) pass(`markets rows ${(symbols as string[]).length}`);
  else if (!(symbols as string[]).length) issue("high", "/markets", "Wait for a[data-symbol]", "one link per instrument", "none", "The table did not render.");

  await page.goto(`${CUSTOMER}/terminal?symbol=BTC%2FUSD`, { waitUntil: "networkidle0", timeout: 20000 });
  const before = await page.$eval("strong[data-symbol]", (el) => el.getAttribute("data-symbol"));
  const label = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const hit = buttons.find((button) => /简洁|简易|高级|Simple|Advanced|Ringkas|Lanjutan/.test(button.textContent || ""));
    if (!hit) return "";
    hit.click();
    return hit.textContent || "";
  });
  await sleep(300);
  const after = await page.$eval("strong[data-symbol]", (el) => el.getAttribute("data-symbol"));
  if (!label) issue("med", "/terminal", "Find the simple/advanced button", "a button", "missing", "The desk toggle is not in the header.");
  else if (before === "BTC/USD" && after === "BTC/USD") pass("simple/advanced keeps BTC/USD");
  else issue("high", "/terminal", "Toggle simple/advanced on BTC/USD", "BTC/USD stays", `${before} -> ${after}`, "setDesk must not call the symbol resolver.");
  await page.close();
}

async function langs(browser: { newPage: () => Promise<Page> }) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  for (const [lang, needle, path] of [
    ["zh", "多资产", "/"],
    ["en", "Many assets", "/"],
    ["ms", "Pelbagai aset", "/"],
    ["ms", "Jemputan dan yuran", "/rewards"],
    ["ms", "Pusat bantuan", "/support"],
    ["ms", "Pemberitahuan", "/inbox"],
    ["ms", "API MERIDEX", "/developers"],
    ["ms", "Cari", "/help"],
  ] as const) {
    await page.goto(CUSTOMER + "/login", { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.evaluate((value: string) => localStorage.setItem("meridex.lang", value), lang);
    await page.goto(CUSTOMER + path, { waitUntil: "domcontentloaded", timeout: 20000 });
    await sleep(300);
    const text = await page.evaluate(() => document.body.innerText);
    if (text.toLowerCase().includes(needle.toLowerCase())) pass(`lang ${lang} ${path}`);
    else issue("med", path, `Set meridex.lang=${lang} and open ${path}`, needle, text.slice(0, 140).replace(/\s+/g, " "), "That screen still ignores Bahasa or English.");
  }
  await page.close();
}

function envOf(pid: number) {
  const raw = readFileSync(`/proc/${pid}/environ`);
  const out: Record<string, string> = {};
  for (const part of raw.toString("utf8").split("\0")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

function pidsMatching(match: string) {
  const text = execFileSync("ps", ["-eo", "pid,cmd"], { encoding: "utf8" });
  const pids: number[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes(match) || /ps -eo|bash -lc|tmux |npm exec|audit\.ts/.test(line)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (pid) pids.push(pid);
  }
  return pids;
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function restart(match: string, health: string) {
  const pids = pidsMatching(match);
  const pid = pids.find((item) => {
    try {
      return readFileSync(`/proc/${item}/cmdline`).includes("loader.mjs") || readFileSync(`/proc/${item}/cmdline`).includes("meridex-engine");
    } catch {
      return false;
    }
  }) ?? pids[pids.length - 1];
  if (!pid) {
    issue("high", health, `find ${match}`, "a pid", "none", "Start it with start-meridex.sh.");
    return;
  }
  const env = envOf(pid);
  const cwd = readlinkSync(`/proc/${pid}/cwd`);
  const argv = readFileSync(`/proc/${pid}/cmdline`).toString("utf8").split("\0").filter(Boolean);
  for (const item of pids) {
    try {
      execFileSync("kill", [String(item)]);
    } catch {
      /* already gone */
    }
  }
  const started = Date.now();
  let down = false;
  while (Date.now() - started < 8000) {
    if (!pids.some((item) => alive(item))) {
      down = true;
      break;
    }
    await sleep(200);
  }
  if (!down) {
    for (const item of pids) {
      try {
        execFileSync("kill", ["-9", String(item)]);
      } catch {
        /* already gone */
      }
    }
    await sleep(400);
    down = !pids.some((item) => alive(item));
  }
  if (!down) issue("med", health, `kill ${pid}`, "process exits", "still up", "The process did not exit.");
  const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: "ignore" });
  child.unref();
  const again = Date.now();
  while (Date.now() - again < 30000) {
    try {
      const res = await fetch(health, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        pass(`restart ${match}`);
        return;
      }
    } catch {
      /* still down */
    }
    await sleep(400);
  }
  issue("high", health, `kill and respawn ${match}`, "health returns", "timed out", "The respawn command did not bind. Check data/*.log.");
}

async function main() {
  const t0 = Date.now();
  await httpPages();
  const tokens = await securityAndAuth();
  try {
    await flows(tokens);
  } catch (err) {
    issue("high", "flows", "customer and admin API flows", "completed", String(err).slice(0, 300), "The audit step threw. See the stack in the run log.");
  }
  try {
    await ui();
  } catch (err) {
    issue("high", "browser", "puppeteer walk", "completed", String(err).slice(0, 300), "Chrome or a page timed out.");
  }
  try {
    const owner = tokens.owner.data.token;
    if (owner) {
      const halted = await call("/api/admin/halt", { method: "POST", body: JSON.stringify({ symbol: "btc/usd" }) }, auth(owner));
      const book = await call("/api/market/book?symbol=BTC/USD");
      const resumed = await call("/api/admin/resume", { method: "POST", body: JSON.stringify({ symbol: "BTC/USD" }) }, auth(owner));
      const haltedFlag = Boolean((book.data as { halted?: boolean }).halted);
      if (halted.status === 200 && haltedFlag && resumed.status === 200) pass("halt and resume BTC/USD");
      else issue("high", "/compliance", "Halt btc/usd then resume", "book halted, then resumed", `halt=${halted.status} ${halted.data.error ?? ""} halted=${haltedFlag} resume=${resumed.status}`, "Symbol must be uppercased and the book must resume. Resume again if it is still halted.");
    }
  } catch (err) {
    issue("high", "/compliance", "halt/resume", "both 200", String(err).slice(0, 200), "Resume BTC/USD from the compliance page.");
  }
  try {
    await restart("meridex-engine serve", "http://127.0.0.1:7108/healthz");
    await restart("src/index.ts", "http://127.0.0.1:7108/healthz");
    const health = await call("/healthz");
    if (health.status === 200 && health.data.ok === true) pass("health after restart");
    else issue("high", "/healthz", "GET /healthz after engine and gateway restart", "200", `${health.status}`, "One of the two processes did not come back.");
  } catch (err) {
    issue("high", "restart", "restart engine and gateway", "both healthy", String(err).slice(0, 200), "start-meridex.sh");
  }
  const seen = new Set<string>();
  const unique = issues.filter((row) => {
    const key = `${row.severity}|${row.page}|${row.actual}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  issues.length = 0;
  issues.push(...unique);
  const report = { passed: passed.length, issues, ms: Date.now() - t0 };
  writeFileSync("/tmp/global-audit.json", JSON.stringify(report, null, 2));
  console.log(`passed=${passed.length} issues=${issues.length} ms=${report.ms}`);
  for (const row of issues) console.log(`- ${row.severity} ${row.page}: ${row.actual}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
