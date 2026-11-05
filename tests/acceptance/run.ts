/**
 * HTTP acceptance against a running gateway (the investor demo by default).
 * Does not flood the book. Ledger conservation lives in gateway/scripts/ledger-stress.ts.
 */
import { createRequire } from "node:module";
import { addressHash, demoAddress } from "../../gateway/src/addresses.ts";
import { signJwt, totp } from "../../gateway/src/crypto.ts";
import { signV1 } from "../../gateway/src/platform.ts";

const require = createRequire(new URL("../../gateway/package.json", import.meta.url));

const base = process.env.GATEWAY_URL ?? "http://127.0.0.1:7108";
const jwtSecret = process.env.JWT_SECRET ?? "<redacted>";

const DEMO = {
  email: "client@meridexexchange.com",
  password: "<redacted>",
  secret: "<redacted>",
};
const ADMIN = {
  email: "compliance@meridexexchange.com",
  password: "<redacted>",
  secret: "<redacted>",
};
const RISK = { email: "risk@meridexexchange.com", password: "<redacted>", secret: "<redacted>" };
const OPS = { email: "ops@meridexexchange.com", password: "<redacted>", secret: "<redacted>" };
const CHECKER = { email: "ops.checker@meridexexchange.com", password: "<redacted>", secret: "<redacted>" };
const SUPPORT = { email: "support@meridexexchange.com", password: "<redacted>", secret: "<redacted>" };
const OWNER = { email: "founder@meridexexchange.com", password: "<redacted>", secret: "<redacted>" };
const US_CUSTOMERS = [
  { email: "james.walker@meridexexchange.com", secret: "<redacted>", password: DEMO.password },
  { email: "aisha.rahman@meridexexchange.com", secret: "<redacted>", password: DEMO.password },
];
const PENDING = { email: "farah.lim@meridexexchange.com", secret: "<redacted>", password: DEMO.password };
const SANCTIONED = { email: "nadia.karim@meridexexchange.com", secret: "<redacted>", password: DEMO.password };

type Body = Record<string, unknown>;

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function call(path: string, init: RequestInit = {}, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...headers, ...(init.headers || {}) },
  });
  const text = await res.text();
  let data: Body = {};
  try {
    data = text ? (JSON.parse(text) as Body) : {};
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data, setCookie: res.headers.get("set-cookie") ?? "" };
}

async function login(email: string, password: string, secret: string, country = "SG", portal: "customer" | "staff" | "pool" = "customer") {
  await new Promise((r) => setTimeout(r, 400));
  const path = portal === "staff" ? "/api/admin/auth/login" : portal === "pool" ? "/api/pool/auth/login" : "/api/auth/login";
  return call(
    path,
    { method: "POST", body: JSON.stringify({ email, password, totp: totp(secret) }) },
    { "x-mock-country": country },
  );
}

async function practiceLedger(userId: number) {
  const { Pool } = require("pg") as {
    Pool: new (cfg: { connectionString: string }) => {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: { real_trades: number; real_orders: number; real_accounts: number; play_trades: number; play_orders: number }[] }>;
      end: () => Promise<void>;
    };
  };
  const db = new Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://meridex:<redacted>@127.0.0.1:5432/meridex" });
  try {
    const row = await db.query(
      `SELECT
         (SELECT count(*)::int FROM trades WHERE buyer_id = $1 OR seller_id = $1) AS real_trades,
         (SELECT count(*)::int FROM user_orders WHERE user_id = $1) AS real_orders,
         (SELECT count(*)::int FROM accounts WHERE customer_id = $1) AS real_accounts,
         (SELECT count(*)::int FROM play_trades WHERE user_id = $1) AS play_trades,
         (SELECT count(*)::int FROM play_orders WHERE user_id = $1) AS play_orders`,
      [userId],
    );
    return row.rows[0];
  } finally {
    await db.end();
  }
}

/** The edited address stays in history, so the public edit route will not put it back. */
async function releaseOwnerDemo(poolId: number, address: string) {
  const { Pool } = require("pg") as {
    Pool: new (cfg: { connectionString: string }) => {
      query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }>;
      end: () => Promise<void>;
    };
  };
  const db = new Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://meridex:<redacted>@127.0.0.1:5432/meridex",
  });
  try {
    await db.query(`DELETE FROM totp_lockouts WHERE user_id = (SELECT id FROM users WHERE email = $1)`, [OWNER.email]);
    await db.query(`UPDATE users SET totp_pending = NULL, recovery_pending = NULL WHERE email = $1`, [OWNER.email]);
    const restored = await db.query(
      `UPDATE address_pool SET address = $1, address_hash = $2, updated_at = now() WHERE id = $3`,
      [address, addressHash(address), poolId],
    );
    if (!restored.rowCount) throw new Error(`demo address row ${poolId} missing`);
    await db.query(
      `UPDATE address_history SET active = false, retired_at = COALESCE(retired_at, now()) WHERE pool_id = $1 AND address <> $2`,
      [poolId, address],
    );
    await db.query(
      `UPDATE address_history SET active = true, retired_at = NULL WHERE pool_id = $1 AND address = $2`,
      [poolId, address],
    );
  } finally {
    await db.end();
  }
}

async function main() {
  const results: string[] = [];
  const note = (line: string) => {
    results.push(line);
    console.log(line);
  };

  const bare = await call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: DEMO.email, password: DEMO.password }),
  });
  assert(bare.status === 401 && bare.data.error === "MFA_REQUIRED", `mfa missing totp: ${bare.status} ${JSON.stringify(bare.data)}`);
  note("mfa_without_totp=401 MFA_REQUIRED");

  const forged = signJwt({ sub: "1", email: DEMO.email, role: "customer", amr: ["pwd"] }, jwtSecret);
  const forgedMe = await call("/api/me", {}, { authorization: `Bearer ${forged}` });
  assert(forgedMe.status === 401, `password-only jwt accepted: ${forgedMe.status}`);
  note("jwt_without_totp_amr=401");

  const demo = await login(DEMO.email, DEMO.password, DEMO.secret);
  assert(demo.status === 200 && typeof demo.data.token === "string", `demo login ${demo.status}`);
  const token = demo.data.token as string;
  note("demo_login=200");

  const health = await call("/healthz");
  const feeds = health.data.feeds as { sources?: unknown; candles?: { source?: string } } | undefined;
  assert(health.status === 200 && health.data.ok === true && feeds && typeof feeds.sources === "object", `health feeds ${health.status} ${JSON.stringify(health.data.feeds)}`);
  note(`health_feeds=${feeds.candles?.source ?? "unknown"}`);

  const band = await call(
    "/api/orders",
    { method: "POST", body: JSON.stringify({ side: "buy", type: "limit", price: "200.00", quantity: "0.100" }) },
    { authorization: `Bearer ${token}`, "x-mock-country": "SG" },
  );
  assert(band.status === 409 && band.data.error === "PRICE_BAND", `price band ${band.status} ${JSON.stringify(band.data)}`);
  note("out_of_band=409 PRICE_BAND");

  const xauNow = await call("/api/market/book?symbol=XAU%2FUSD");
  const xauRef = Number(xauNow.data.referencePrice);
  assert(xauRef > 1000, `xau reference ${xauRef}`);
  const inside = (Math.round(xauRef * 0.995) / 100).toFixed(2);
  let allowed = 0;
  for (const person of US_CUSTOMERS) {
    const session = await login(person.email, person.password, person.secret, "US");
    assert(session.status === 200, `${person.email} login ${session.status} ${JSON.stringify(session.data)}`);
    const order = await call(
      "/api/orders",
      { method: "POST", body: JSON.stringify({ side: "buy", type: "limit", price: inside, quantity: "0.100" }) },
      { authorization: `Bearer ${session.data.token}`, "x-mock-country": "US" },
    );
    assert(order.status === 200, `${person.email} order ${order.status} ${JSON.stringify(order.data)}`);
    allowed += 1;
  }
  note(`us_customers_trading=${allowed}/${US_CUSTOMERS.length}`);

  const sanctioned = await login(SANCTIONED.email, SANCTIONED.password, SANCTIONED.secret);
  assert(sanctioned.status === 200, `sanctions login ${sanctioned.status} ${JSON.stringify(sanctioned.data)}`);
  const sanctionedOrder = await call(
    "/api/orders",
    { method: "POST", body: JSON.stringify({ side: "buy", type: "limit", price: "130.00", quantity: "0.100" }) },
    { authorization: `Bearer ${sanctioned.data.token}`, "x-mock-country": "SG" },
  );
  assert(sanctionedOrder.status === 403 && sanctionedOrder.data.error === "SANCTIONS_HIT", `sanctions ${sanctionedOrder.status} ${JSON.stringify(sanctionedOrder.data)}`);
  note("sanctions_hit=403 SANCTIONS_HIT");

  const pending = await login(PENDING.email, PENDING.password, PENDING.secret, "MY");
  assert(pending.status === 200, `my login ${pending.status}`);
  const pendingOrder = await call(
    "/api/orders",
    { method: "POST", body: JSON.stringify({ side: "buy", type: "limit", price: "130.00", quantity: "0.100" }) },
    { authorization: `Bearer ${pending.data.token}`, "x-mock-country": "MY" },
  );
  assert(pendingOrder.status === 403 && pendingOrder.data.error === "KYC_PENDING", `my trade ${pendingOrder.status} ${JSON.stringify(pendingOrder.data)}`);
  note("my_pending=403 KYC_PENDING");

  const geo = await login(DEMO.email, DEMO.password, DEMO.secret, "US");
  assert(geo.status === 200, `us source should be allowed ${geo.status} ${JSON.stringify(geo.data)}`);
  note("us_ip_login=200");

  const mismatch = await login(DEMO.email, DEMO.password, DEMO.secret, "MY");
  assert(mismatch.status === 200, `mismatch login ${mismatch.status}`);
  note("residence_mismatch_login=200");

  const staffOnCustomer = await login(ADMIN.email, ADMIN.password, ADMIN.secret);
  assert(staffOnCustomer.status === 403 && staffOnCustomer.data.error === "STAFF_PORTAL", `staff on customer ${staffOnCustomer.status} ${JSON.stringify(staffOnCustomer.data)}`);
  const customerOnAdmin = await login(DEMO.email, DEMO.password, DEMO.secret, "SG", "staff");
  assert(customerOnAdmin.status === 403 && customerOnAdmin.data.error === "CUSTOMER_PORTAL", `customer on admin ${customerOnAdmin.status} ${JSON.stringify(customerOnAdmin.data)}`);
  note("portal_login=1");

  const admin = await login(ADMIN.email, ADMIN.password, ADMIN.secret, "SG", "staff");
  assert(admin.status === 200 && admin.data.role === "admin", `admin ${admin.status}`);
  const alerts = await call("/api/admin/alerts", {}, { authorization: `Bearer ${admin.data.token}` });
  const rows = alerts.data as unknown as { action: string; ip_country: string | null; email: string | null }[];
  assert(Array.isArray(rows), "alerts not array");
  const sawMismatch = rows.some((row) => row.action === "alert" && row.ip_country === "MY" && row.email === DEMO.email);
  assert(sawMismatch, "missing MY mismatch alert");
  const rules = await call("/api/admin/jurisdictions", {}, { authorization: `Bearer ${admin.data.token}` });
  const ruleRows = (rules.data.rules as { country: string; access: string }[]) ?? [];
  assert(ruleRows.find((row) => row.country === "SG")?.access === "allow", "SG not allow");
  assert(ruleRows.find((row) => row.country === "US")?.access === "allow", "US not allow");
  assert(ruleRows.find((row) => row.country === "MY")?.access === "allow", "MY not allow");
  assert(ruleRows.find((row) => row.country === "HK")?.access === "allow", "HK not allow");
  assert(ruleRows.find((row) => row.country === "JP")?.access === "allow", "JP not allow");
  const kp = ruleRows.find((row) => row.country === "KP") as { access?: string; locked?: boolean } | undefined;
  assert(kp?.access === "block" && kp.locked === true, `KP not locked ${JSON.stringify(kp)}`);
  const locked = await call(
    "/api/admin/jurisdictions",
    { method: "POST", body: JSON.stringify({ country: "KP", access: "allow" }) },
    { authorization: `Bearer ${admin.data.token}` },
  );
  assert(locked.status === 403 && locked.data.error === "JURISDICTION_LOCKED", `unlock KP ${locked.status} ${JSON.stringify(locked.data)}`);
  const geoBlock = await login(DEMO.email, DEMO.password, DEMO.secret, "KP");
  assert(geoBlock.status === 403 && geoBlock.data.error === "GEO_BLOCKED", `kp geo ${geoBlock.status} ${JSON.stringify(geoBlock.data)}`);
  const removed = await call(
    "/api/admin/jurisdictions/KP",
    { method: "DELETE" },
    { authorization: `Bearer ${admin.data.token}` },
  );
  assert(removed.status === 403 && removed.data.error === "JURISDICTION_LOCKED", `remove KP ${removed.status} ${JSON.stringify(removed.data)}`);
  const coverageRes = await call("/api/jurisdictions");
  const coverage = coverageRes.data as { count: number; regions: { id: string; countries: { code: string }[] }[] };
  assert(coverageRes.status === 200 && coverage.count >= 49, `coverage ${coverageRes.status} ${coverage.count}`);
  const covered = coverage.regions.flatMap((region) => region.countries.map((row) => row.code));
  assert(covered.includes("HK") && covered.includes("JP") && covered.includes("TH") && covered.includes("AE") && covered.includes("US"), "selector missing Asia or US");
  assert(!covered.includes("KP") && !covered.includes("IR") && !covered.includes("SY"), "sanctioned jurisdictions are selectable");
  note(`alerts=${rows.length} mismatch=1 kp_locked=1 coverage=${coverage.count} defaults=Asia+US allow`);

  const authz = { authorization: `Bearer ${token}`, "x-mock-country": "SG" };
  const summary = await call("/api/market/summary");
  const lastCents = Number(summary.data.lastPrice ?? summary.data.referencePrice);
  const bandHigh = Number(summary.data.bandHigh);
  const bandLow = Number(summary.data.bandLow);
  const px = (cents: number) => (cents / 100).toFixed(2);
  const clamp = (cents: number) => Math.min(bandHigh - 5, Math.max(bandLow + 5, Math.round(cents)));
  const stop = await call(
    "/api/orders",
    { method: "POST", body: JSON.stringify({ side: "buy", type: "stop_limit", price: px(clamp(lastCents + 180)), stopPrice: px(clamp(lastCents + 120)), quantity: "0.100" }) },
    authz,
  );
  assert(stop.status === 200 && stop.data.status === "armed", `stop ${stop.status} ${JSON.stringify(stop.data)}`);
  const stopCancel = await call(`/api/orders/${stop.data.orderId}/cancel`, { method: "POST" }, authz);
  assert(stopCancel.status === 200 && stopCancel.data.status === "canceled", `stop cancel ${stopCancel.status} ${JSON.stringify(stopCancel.data)}`);
  note("stop_limit_armed_then_canceled=1");

  const oco = await call(
    "/api/orders",
    {
      method: "POST",
      body: JSON.stringify({
        side: "sell",
        type: "oco",
        price: px(clamp(lastCents + 80)),
        stopPrice: px(clamp(lastCents - 80)),
        stopLimitPrice: px(clamp(lastCents - 100)),
        quantity: "0.100",
      }),
    },
    authz,
  );
  assert(oco.status === 200 && oco.data.status === "open", `oco ${oco.status} ${JSON.stringify(oco.data)}`);
  const ocoCancel = await call(`/api/orders/${oco.data.orderId}/cancel`, { method: "POST" }, authz);
  assert(ocoCancel.status === 200, `oco cancel ${ocoCancel.status} ${JSON.stringify(ocoCancel.data)}`);
  note("oco_resting_then_canceled=1");

  const resting = await call(
    "/api/orders",
    { method: "POST", body: JSON.stringify({ side: "buy", type: "limit", price: px(clamp(lastCents - 200)), quantity: "0.100" }) },
    authz,
  );
  assert(resting.status === 200 && resting.data.status === "open", `resting ${resting.status} ${JSON.stringify(resting.data)}`);
  const amended = await call(
    `/api/orders/${resting.data.orderId}/amend`,
    { method: "POST", body: JSON.stringify({ price: px(clamp(lastCents - 180)), quantity: "0.200" }) },
    authz,
  );
  assert(amended.status === 200 && amended.data.status === "open" && amended.data.orderId !== resting.data.orderId, `amend ${amended.status} ${JSON.stringify(amended.data)}`);
  const second = await call(
    "/api/orders",
    { method: "POST", body: JSON.stringify({ side: "buy", type: "limit", price: px(clamp(lastCents - 250)), quantity: "0.100" }) },
    authz,
  );
  assert(second.status === 200, `second ${second.status}`);
  const wiped = await call("/api/orders/cancel-all", { method: "POST" }, authz);
  assert(wiped.status === 200 && Array.isArray(wiped.data.canceled) && (wiped.data.canceled as string[]).length >= 1, `cancel all ${JSON.stringify(wiped.data)}`);
  note(`amend_and_cancel_all=1 canceled=${(wiped.data.canceled as string[]).length}`);

  const rail = await call(
    "/api/wallet/rails",
    { method: "POST", body: JSON.stringify({ direction: "deposit", amount: "25.00" }) },
    authz,
  );
  assert(rail.status === 200 && rail.data.status === "submitted", `rail ${rail.status} ${JSON.stringify(rail.data)}`);
  let settled = rail.data.status;
  for (let i = 0; i < 12 && settled !== "settled"; i++) {
    await new Promise((r) => setTimeout(r, 700));
    const list = await call("/api/wallet/rails", {}, authz);
    const rows = list.data as unknown as { id: string; status: string }[];
    settled = rows.find((row) => row.id === rail.data.id)?.status ?? settled;
  }
  assert(settled === "settled", `rail not settled: ${settled}`);
  note("rail_deposit_settled=1");

  const redeem = await call(
    "/api/wallet/redemptions",
    { method: "POST", body: JSON.stringify({ product: "coin_1oz", method: "vault_pickup", qty: 1 }) },
    authz,
  );
  assert(redeem.status === 200 && redeem.data.status === "requested", `redeem ${redeem.status} ${JSON.stringify(redeem.data)}`);
  let ready = redeem.data.status as string;
  for (let i = 0; i < 12 && ready !== "ready" && ready !== "failed"; i++) {
    await new Promise((r) => setTimeout(r, 700));
    const list = await call("/api/wallet/redemptions", {}, authz);
    const rows = list.data as unknown as { id: string; status: string }[];
    ready = rows.find((row) => row.id === redeem.data.id)?.status ?? ready;
  }
  assert(ready === "ready", `redemption ${ready}`);
  note("redemption_ready=1");

  const catalog = await call("/api/market/instruments");
  const instruments = catalog.data.instruments as {
    symbol: string;
    price_scale: string;
    qty_scale: string;
    price_decimals: number;
    qty_decimals: number;
    min_qty: string;
    ref_price: string;
    category: string;
  }[];
  assert(Array.isArray(instruments) && instruments.length >= 56, `instrument count ${instruments?.length}`);
  note(`instruments=${instruments.length} new=${instruments.length - 1}`);

  const mei = await login("mei.tan@meridexexchange.com", DEMO.password, "<redacted>");
  assert(mei.status === 200, `mei login ${mei.status}`);
  const meiAuth = { authorization: `Bearer ${mei.data.token as string}` };

  async function cross(symbol: string) {
    const spec = instruments.find((row) => row.symbol === symbol);
    assert(spec, symbol);
    const book = await call(`/api/market/book?symbol=${encodeURIComponent(symbol)}`);
    assert(book.status === 200, `book ${symbol} ${book.status} ${JSON.stringify(book.data)}`);
    if (book.data.halted) {
      const resumed = await call(
        "/api/admin/resume",
        { method: "POST", body: JSON.stringify({ symbol }) },
        { authorization: `Bearer ${admin.data.token}` },
      );
      assert(resumed.status === 200, `resume ${symbol} ${resumed.status}`);
    }
    const ref = Number(book.data.referencePrice ?? spec.ref_price);
    const bid = book.data.bids?.[0]?.price ?? ref;
    const ask = book.data.asks?.[0]?.price ?? ref;
    const sellPrice = (Number(bid) / Number(spec.price_scale)).toFixed(spec.price_decimals);
    const buyPrice = (Number(ask) / Number(spec.price_scale)).toFixed(spec.price_decimals);
    const qty = (Number(spec.min_qty) / Number(spec.qty_scale)).toFixed(spec.qty_decimals);
    const sell = await call(
      "/api/orders",
      { method: "POST", body: JSON.stringify({ side: "sell", type: "limit", price: sellPrice, quantity: qty, symbol }) },
      authz,
    );
    const flat = sell.status === 400 && sell.data.error === "INSUFFICIENT_FUNDS";
    if (flat) {
      const bought = await call(
        "/api/orders",
        { method: "POST", body: JSON.stringify({ side: "buy", type: "limit", price: buyPrice, quantity: qty, symbol }) },
        authz,
      );
      assert(bought.status === 200 && Number(bought.data.filledMg) > 0, `buy flat ${symbol} ${bought.status} ${JSON.stringify(bought.data)}`);
    } else {
      assert(sell.status === 200, `sell ${symbol} ${sell.status} ${JSON.stringify(sell.data)}`);
    }
    const sellFilled = !flat && Number(sell.data.filledMg) > 0;
    if (!sellFilled && !flat) {
      const buy = await call(
        "/api/orders",
        { method: "POST", body: JSON.stringify({ side: "buy", type: "limit", price: buyPrice, quantity: qty, symbol }) },
        meiAuth,
      );
      assert(buy.status === 200 && Number(buy.data.filledMg) > 0, `buy ${symbol} ${buy.status} ${JSON.stringify(buy.data)}`);
    }
    const tape = await call(`/api/market/trades?symbol=${encodeURIComponent(symbol)}`);
    assert(tape.status === 200 && Array.isArray(tape.data) && tape.data.length > 0, `tape ${symbol} ${tape.status}`);
  }

  const xauLiveBook = await call("/api/market/book?symbol=XAU%2FUSD");
  const asiaPx = (Math.round(Number(xauLiveBook.data.referencePrice) * 0.995) / 100).toFixed(2);
  const cn = await login("wei.lin@meridexexchange.com", DEMO.password, "<redacted>", "CN");
  assert(cn.status === 200, `cn login ${cn.status} ${JSON.stringify(cn.data)}`);
  const cnAuth = { authorization: `Bearer ${cn.data.token}`, "x-mock-country": "CN" };
  const cnBtc = await call(
    "/api/orders",
    { method: "POST", body: JSON.stringify({ side: "buy", type: "limit", price: "65000.00", quantity: "0.00010000", symbol: "BTC/USD" }) },
    cnAuth,
  );
  assert(cnBtc.status === 403 && cnBtc.data.error === "CATEGORY_BLOCKED", `cn btc ${cnBtc.status} ${JSON.stringify(cnBtc.data)}`);
  const cnGold = await call(
    "/api/orders",
    { method: "POST", body: JSON.stringify({ side: "buy", type: "limit", price: asiaPx, quantity: "0.100" }) },
    cnAuth,
  );
  assert(cnGold.status === 200, `cn gold ${cnGold.status} ${JSON.stringify(cnGold.data)}`);
  const hk = await login("hk.chen@meridexexchange.com", DEMO.password, "<redacted>", "HK");
  assert(hk.status === 200, `hk login ${hk.status}`);
  const hkGold = await call(
    "/api/orders",
    { method: "POST", body: JSON.stringify({ side: "buy", type: "limit", price: asiaPx, quantity: "0.100" }) },
    { authorization: `Bearer ${hk.data.token}`, "x-mock-country": "HK" },
  );
  assert(hkGold.status === 200, `hk gold ${hkGold.status} ${JSON.stringify(hkGold.data)}`);
  note("category_gate_cn_crypto=403 asia_gold=1");

  await cross("XAG/USD");
  note("xag_matched=1");

  await cross("BTC/USD");
  await cross("ETH/USD");
  await cross("BRENT/USD");
  note("btc_eth_brent_matched=1");

  const bulkOps = await login(OPS.email, OPS.password, OPS.secret, "SG", "staff");
  const bulkChecker = await login(CHECKER.email, CHECKER.password, CHECKER.secret, "SG", "staff");
  assert(bulkOps.status === 200 && bulkChecker.status === 200, `ops login ${bulkOps.status} ${bulkChecker.status}`);
  const bulkProposed = await call(
    "/api/admin/ops/changes",
    { method: "POST", body: JSON.stringify({ kind: "jurisdiction_bulk", payload: { region: "central", field: "crypto", access: "pending" } }) },
    { authorization: `Bearer ${bulkOps.data.token}` },
  );
  assert(bulkProposed.status === 200 && bulkProposed.data.status === "pending", `bulk propose ${bulkProposed.status} ${JSON.stringify(bulkProposed.data)}`);
  const bulkSelf = await call(
    `/api/admin/ops/changes/${bulkProposed.data.id}`,
    { method: "POST", body: JSON.stringify({ action: "approve", reason: "同一人" }) },
    { authorization: `Bearer ${bulkOps.data.token}` },
  );
  assert(bulkSelf.status === 403 && bulkSelf.data.error === "MAKER_CHECKER", `self approve ${bulkSelf.status}`);
  const approvedBulk = await call(
    `/api/admin/ops/changes/${bulkProposed.data.id}`,
    { method: "POST", body: JSON.stringify({ action: "approve", reason: "复核中亚加密货币" }) },
    { authorization: `Bearer ${bulkChecker.data.token}` },
  );
  assert(approvedBulk.status === 200 && approvedBulk.data.status === "approved", `bulk approve ${approvedBulk.status} ${JSON.stringify(approvedBulk.data)}`);
  const afterBulk = await call("/api/admin/categories", {}, { authorization: `Bearer ${admin.data.token}` });
  const catRows = (afterBulk.data.rules as { category: string; country: string; access: string }[]) ?? [];
  assert(catRows.find((row) => row.category === "crypto" && row.country === "KZ")?.access === "pending", "KZ crypto not pending");
  assert(catRows.find((row) => row.category === "crypto" && row.country === "KP")?.access === "block", "KP crypto changed");
  const restore = await call(
    "/api/admin/ops/changes",
    { method: "POST", body: JSON.stringify({ kind: "jurisdiction_bulk", payload: { region: "central", field: "crypto", access: "allow" } }) },
    { authorization: `Bearer ${bulkOps.data.token}` },
  );
  const restored = await call(
    `/api/admin/ops/changes/${restore.data.id}`,
    { method: "POST", body: JSON.stringify({ action: "approve", reason: "恢复默认" }) },
    { authorization: `Bearer ${bulkChecker.data.token}` },
  );
  assert(restored.status === 200, `bulk restore ${restored.status}`);
  note("jurisdiction_bulk=1");

  const beforeBtc = await call("/api/market/book?symbol=BTC%2FUSD");
  const p0 = beforeBtc.data.lastPrice as number | null;
  let moved = false;
  let latest = p0;
  const watchStart = Date.now();
  while (Date.now() - watchStart < 60_000) {
    await new Promise((r) => setTimeout(r, 5_000));
    const snap = await call("/api/market/book?symbol=BTC%2FUSD");
    latest = snap.data.lastPrice as number | null;
    if (latest != null && latest !== p0) moved = true;
  }
  let afterBtc = await call("/api/market/book?symbol=BTC%2FUSD");
  for (let i = 0; i < 8 && ((afterBtc.data.bids?.length ?? 0) < 10 || (afterBtc.data.asks?.length ?? 0) < 10); i++) {
    await new Promise((r) => setTimeout(r, 1_000));
    afterBtc = await call("/api/market/book?symbol=BTC%2FUSD");
  }
  assert(moved || (latest != null && latest !== p0), `btc last frozen ${p0} -> ${latest}`);
  assert((afterBtc.data.bids?.length ?? 0) >= 10 && (afterBtc.data.asks?.length ?? 0) >= 10, `btc depth bids=${afterBtc.data.bids?.length} asks=${afterBtc.data.asks?.length}`);
  const minBars: Record<string, number> = { "1m": 60, "5m": 48, "15m": 48, "1H": 48, "4H": 48, "1D": 90 };
  for (const [tf, n] of Object.entries(minBars)) {
    const candles = await call(`/api/market/candles?symbol=BTC%2FUSD&tf=${encodeURIComponent(tf)}`);
    const count = Array.isArray(candles.data.candles) ? candles.data.candles.length : 0;
    assert(candles.status === 200 && count >= n, `candles ${tf} ${candles.status} n=${count}`);
  }
  note(`btc_live ${p0}->${afterBtc.data.lastPrice} bids=${afterBtc.data.bids.length} asks=${afterBtc.data.asks.length}`);

  const goldRes = await fetch("https://api.gold-api.com/price/XAU", { headers: { accept: "application/json" } });
  assert(goldRes.ok, `gold-api ${goldRes.status}`);
  const goldBody = (await goldRes.json()) as { price?: number };
  const oz = Number(goldBody.price);
  assert(Number.isFinite(oz) && oz > 0, `gold-api price ${String(goldBody.price)}`);
  const goldPerGram = oz / 31.1034768;
  let xauLive = await call("/api/market/book?symbol=XAU%2FUSD");
  let midCents = 0;
  for (let i = 0; i < 8; i++) {
    const bid = Number(xauLive.data.bids?.[0]?.price ?? 0);
    const ask = Number(xauLive.data.asks?.[0]?.price ?? 0);
    const ref = Number(xauLive.data.referencePrice ?? 0);
    midCents = bid > 0 && ask > 0 ? (bid + ask) / 2 : ref;
    const usd = midCents / 100;
    if (xauLive.data.halted !== true && midCents > 0 && Math.abs(usd - goldPerGram) / goldPerGram < 0.01) break;
    await new Promise((r) => setTimeout(r, 2000));
    xauLive = await call("/api/market/book?symbol=XAU%2FUSD");
  }
  const midUsd = midCents / 100;
  assert(xauLive.data.halted !== true, `xau halted ${JSON.stringify({ ref: xauLive.data.referencePrice, halt: xauLive.data.halted })}`);
  assert(midCents > 0 && Math.abs(midUsd - goldPerGram) / goldPerGram < 0.01, `xau mid ${midUsd.toFixed(4)} vs gold-api ${goldPerGram.toFixed(4)}`);
  const xauDay = await call("/api/market/candles?symbol=XAU%2FUSD&tf=1D");
  const xauBars = (xauDay.data.candles as { close: number }[] | undefined) ?? [];
  const xauClose = xauBars[xauBars.length - 1]?.close;
  assert(typeof xauClose === "number" && Math.abs(xauClose - goldPerGram) / goldPerGram < 0.01, `xau history ${xauClose} vs gold-api ${goldPerGram.toFixed(4)}`);
  note(`xau_vs_goldapi mid=${midUsd.toFixed(4)} ref=${goldPerGram.toFixed(4)} close=${xauClose}`);

  const alertPrice = ((Number(afterBtc.data.lastPrice) / 100) / 2).toFixed(2);
  const createdAlert = await call(
    "/api/alerts",
    { method: "POST", body: JSON.stringify({ symbol: "BTC/USD", direction: "above", price: alertPrice }) },
    authz,
  );
  assert(createdAlert.status === 200 && createdAlert.data.armed === true, `alert create ${createdAlert.status} ${JSON.stringify(createdAlert.data)}`);
  let fired = false;
  for (let i = 0; i < 8 && !fired; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const notices = await call("/api/notices", {}, authz);
    const list = (notices.data.notices as { kind?: string; symbol?: string }[] | undefined) ?? [];
    fired = notices.status === 200 && list.some((row) => row.kind === "price_alert" && row.symbol === "BTC/USD");
  }
  assert(fired, "price alert did not fire");
  note("price_alert_fired=1");

  const tape = await call("/api/market/tickers");
  const quotes = tape.data as { symbol: string; global?: { kind?: string; volumeUsd?: number | null; source?: string | null } }[];
  const eurQuote = quotes.find((row) => row.symbol === "EUR/USD");
  const zincQuote = quotes.find((row) => row.symbol === "ZINC/USD");
  const btcQuote = quotes.find((row) => row.symbol === "BTC/USD");
  assert(eurQuote?.global?.kind === "otc" && eurQuote.global.volumeUsd == null, `fx volume ${JSON.stringify(eurQuote?.global)}`);
  assert(zincQuote?.global?.kind === "none" && zincQuote.global.volumeUsd == null, `zinc volume ${JSON.stringify(zincQuote?.global)}`);
  assert(btcQuote?.global != null && (btcQuote.global.volumeUsd == null || btcQuote.global.volumeUsd > 0), `btc global ${JSON.stringify(btcQuote?.global)}`);
  note(`global_btc=${btcQuote?.global?.source ?? "none"}:${btcQuote?.global?.volumeUsd ?? "—"}`);

  const balBefore = await call("/api/balances", {}, authz);
  const tradesBefore = await call("/api/trades", {}, authz);
  const ordersBefore = await call("/api/orders", {}, authz);
  assert(balBefore.status === 200 && tradesBefore.status === 200 && ordersBefore.status === 200, "paper baseline");
  const resetPaper = await call("/api/paper", { method: "POST", body: JSON.stringify({ action: "reset" }) }, authz);
  assert(resetPaper.status === 200 && resetPaper.data.enabled === true, `paper reset ${resetPaper.status} ${JSON.stringify(resetPaper.data)}`);
  const seed = BigInt((resetPaper.data.balances as { USD: { available: string } }).USD.available);
  assert(seed === 100_000n * 1_000_000n, `paper seed ${seed}`);
  const xauBook = await call("/api/market/book?symbol=XAU%2FUSD");
  const ask = xauBook.data.asks?.[0]?.price;
  assert(typeof ask === "number" && ask > 0, `xau ask ${ask}`);
  const paperPx = (Number(ask) / 100).toFixed(2);
  const paperBuy = await call(
    "/api/paper/orders",
    { method: "POST", body: JSON.stringify({ side: "buy", type: "limit", price: paperPx, quantity: "0.100", symbol: "XAU/USD" }) },
    authz,
  );
  assert(paperBuy.status === 200 && BigInt(String(paperBuy.data.filled ?? "0")) > 0n, `paper fill ${paperBuy.status} ${JSON.stringify(paperBuy.data)}`);
  const balAfter = await call("/api/balances", {}, authz);
  const tradesAfter = await call("/api/trades", {}, authz);
  const ordersAfter = await call("/api/orders", {}, authz);
  const snap = (body: Body) =>
    ((body.assets as { asset: string; available: string; reserved: string }[] | undefined) ?? [])
      .map((row) => `${row.asset}:${row.available}:${row.reserved}`)
      .sort()
      .join("|");
  assert(snap(balBefore.data) === snap(balAfter.data), `ledger balances moved ${snap(balBefore.data)} -> ${snap(balAfter.data)}`);
  assert(JSON.stringify(balBefore.data.USD) === JSON.stringify(balAfter.data.USD), "USD ledger changed");
  assert(JSON.stringify(balBefore.data.XAU) === JSON.stringify(balAfter.data.XAU), "XAU ledger changed");
  assert((tradesAfter.data as unknown[]).length === (tradesBefore.data as unknown[]).length, "paper fill landed in the real tape");
  assert((ordersAfter.data as unknown[]).length === (ordersBefore.data as unknown[]).length, "paper order landed in the real book");
  const paperAfter = await call("/api/paper", {}, authz);
  const left = BigInt((paperAfter.data.balances as { USD: { available: string } }).USD.available);
  assert(left < seed, `paper usd did not fall ${left}`);
  const xauPaper = BigInt((paperAfter.data.balances as { XAU: { available: string } }).XAU.available);
  assert(xauPaper > 0n, "paper gold missing");
  const portfolio = await call("/api/account/portfolio", {}, authz);
  assert(portfolio.status === 200 && typeof portfolio.data.equityUusd === "string" && Array.isArray(portfolio.data.curve) && (portfolio.data.curve as unknown[]).length >= 1, `portfolio ${portfolio.status}`);
  const paperBook = await call("/api/account/portfolio?namespace=paper", {}, authz);
  assert(paperBook.status === 200 && paperBook.data.namespace === "paper" && BigInt(String(paperBook.data.equityUusd)) > 0n, `paper portfolio ${JSON.stringify(paperBook.data)}`);
  await call("/api/paper", { method: "POST", body: JSON.stringify({ action: "reset" }) }, authz);
  await call("/api/paper", { method: "POST", body: JSON.stringify({ action: "disable" }) }, authz);
  note("paper_isolated=1");

  const adminAuth = { authorization: `Bearer ${admin.data.token}` };
  const quote = await call(
    "/api/convert/quote",
    { method: "POST", body: JSON.stringify({ symbol: "XAU/USD", side: "buy", quantity: "0.100", slippageBps: 50, paper: false }) },
    authz,
  );
  assert(quote.status === 200 && typeof quote.data.quoteId === "string" && BigInt(String(quote.data.feeUusd)) > 0n, `convert quote ${quote.status} ${JSON.stringify(quote.data)}`);
  const exec = await call("/api/convert/execute", { method: "POST", body: JSON.stringify({ quoteId: quote.data.quoteId }) }, authz);
  assert(exec.status === 200 && BigInt(String(exec.data.filled ?? "0")) > 0n, `convert fill ${exec.status} ${JSON.stringify(exec.data)}`);
  const hist = await call("/api/convert/history", {}, authz);
  const fills = (hist.data.fills as unknown[] | undefined) ?? [];
  assert(hist.status === 200 && fills.length >= 1, `convert history ${hist.status}`);
  note(`convert_filled=1 path=${exec.data.path}`);

  const ledgerBefore = await call("/api/balances", {}, authz);
  await call("/api/paper", { method: "POST", body: JSON.stringify({ action: "enable" }) }, authz);
  const paperQuote = await call(
    "/api/convert/quote",
    { method: "POST", body: JSON.stringify({ symbol: "XAU/USD", side: "buy", quantity: "0.100", slippageBps: 50, paper: true }) },
    authz,
  );
  assert(paperQuote.status === 200, `paper quote ${paperQuote.status} ${JSON.stringify(paperQuote.data)}`);
  const paperExec = await call("/api/convert/execute", { method: "POST", body: JSON.stringify({ quoteId: paperQuote.data.quoteId }) }, authz);
  assert(paperExec.status === 200 && paperExec.data.namespace === "paper", `paper convert ${paperExec.status} ${JSON.stringify(paperExec.data)}`);
  const ledgerAfter = await call("/api/balances", {}, authz);
  const snapBal = (body: Body) =>
    ((body.assets as { asset: string; available: string; reserved: string }[] | undefined) ?? [])
      .map((row) => `${row.asset}:${row.available}:${row.reserved}`)
      .sort()
      .join("|");
  assert(snapBal(ledgerBefore.data) === snapBal(ledgerAfter.data), "paper convert moved the ledger");
  await call("/api/paper", { method: "POST", body: JSON.stringify({ action: "disable" }) }, authz);

  const plan = await call(
    "/api/recurring",
    { method: "POST", body: JSON.stringify({ symbol: "XAU/USD", amount: "20.00", cadence: "daily", paper: false }) },
    authz,
  );
  assert(plan.status === 200 && plan.data.id, `plan ${plan.status} ${JSON.stringify(plan.data)}`);
  const ran = await call(`/api/recurring/${plan.data.id}/run`, { method: "POST", body: "{}" }, authz);
  assert(ran.status === 200 && ran.data.status === "filled", `recurring run ${ran.status} ${JSON.stringify(ran.data)}`);
  const stopped = await call(`/api/recurring/${plan.data.id}`, { method: "POST", body: JSON.stringify({ action: "cancel" }) }, authz);
  assert(stopped.status === 200 && stopped.data.status === "canceled", `plan cancel ${stopped.status}`);
  note("recurring_ran=1");

  const realMargin = await call("/api/margin/borrow", { method: "POST", body: JSON.stringify({ amount: "100.00" }) }, authz);
  assert(realMargin.status === 403 && realMargin.data.error === "LIVE_OFF", `real margin ${realMargin.status} ${JSON.stringify(realMargin.data)}`);
  const realPerp = await call(
    "/api/perps/orders",
    { method: "POST", body: JSON.stringify({ symbol: "XAU-PERP", side: "buy", quantity: "0.100", leverage: 2 }) },
    authz,
  );
  assert(realPerp.status === 403 && realPerp.data.error === "LIVE_OFF", `real perp ${realPerp.status} ${JSON.stringify(realPerp.data)}`);
  const realCopy = await call(
    "/api/copy/follow",
    { method: "POST", body: JSON.stringify({ leaderId: "jin-heng", allocation: "100.00", maxDrawdownBps: 800 }) },
    authz,
  );
  assert(realCopy.status === 403 && realCopy.data.error === "LIVE_OFF", `real copy ${realCopy.status} ${JSON.stringify(realCopy.data)}`);
  note("demo_blocked_real=1");

  const openMargin = await call("/api/admin/modes", { method: "POST", body: JSON.stringify({ mode: "margin", country: "SG", access: "allow" }) }, adminAuth);
  assert(openMargin.status === 200, `open margin ${openMargin.status} ${JSON.stringify(openMargin.data)}`);
  await call("/api/paper", { method: "POST", body: JSON.stringify({ action: "enable" }) }, authz);
  const paperMargin = await call("/api/margin/borrow", { method: "POST", body: JSON.stringify({ amount: "100.00" }) }, authz);
  await call("/api/admin/modes", { method: "POST", body: JSON.stringify({ mode: "margin", country: "SG", access: "block" }) }, adminAuth);
  await call("/api/paper", { method: "POST", body: JSON.stringify({ action: "disable" }) }, authz);
  assert(paperMargin.status === 200, `paper margin ${paperMargin.status} ${JSON.stringify(paperMargin.data)}`);
  const blockedAgain = await call("/api/margin/borrow", { method: "POST", body: JSON.stringify({ amount: "50.00" }) }, authz);
  assert(blockedAgain.status === 403, `margin reblock ${blockedAgain.status} ${JSON.stringify(blockedAgain.data)}`);

  const usDeny = await call("/api/admin/modes", { method: "POST", body: JSON.stringify({ mode: "margin", country: "US", access: "allow" }) }, adminAuth);
  assert(usDeny.status === 403 && usDeny.data.error === "US_RETAIL_BLOCK", `us switch ${usDeny.status} ${JSON.stringify(usDeny.data)}`);
  const usPerpDeny = await call("/api/admin/modes", { method: "POST", body: JSON.stringify({ mode: "perp", country: "US", access: "allow" }) }, adminAuth);
  assert(usPerpDeny.status === 403 && usPerpDeny.data.error === "US_RETAIL_BLOCK", `us perp switch ${usPerpDeny.status}`);
  const us = await login(US_CUSTOMERS[0].email, US_CUSTOMERS[0].password, US_CUSTOMERS[0].secret, "US");
  assert(us.status === 200 && us.data.token, `us login ${us.status}`);
  const usAuth = { authorization: `Bearer ${us.data.token}`, "x-mock-country": "US" };
  await call("/api/admin/modes", { method: "POST", body: JSON.stringify({ mode: "margin", country: "US", access: "allow" }) }, adminAuth);
  await call("/api/paper", { method: "POST", body: JSON.stringify({ action: "enable" }) }, usAuth);
  const usMargin = await call("/api/margin/borrow", { method: "POST", body: JSON.stringify({ amount: "100.00" }) }, usAuth);
  const usPerp = await call(
    "/api/perps/orders",
    { method: "POST", body: JSON.stringify({ symbol: "BTC-PERP", side: "buy", quantity: "0.0001", leverage: 2 }) },
    usAuth,
  );
  await call("/api/paper", { method: "POST", body: JSON.stringify({ action: "disable" }) }, usAuth);
  assert(usMargin.status === 403 && usMargin.data.error === "US_RETAIL_BLOCK", `us margin ${usMargin.status} ${JSON.stringify(usMargin.data)}`);
  assert(usPerp.status === 403 && usPerp.data.error === "US_RETAIL_BLOCK", `us perp ${usPerp.status} ${JSON.stringify(usPerp.data)}`);
  note("us_hard_block=1");

  const risk = await login(RISK.email, RISK.password, RISK.secret, "SG", "staff");
  const ops = await login(OPS.email, OPS.password, OPS.secret, "SG", "staff");
  const checker = await login(CHECKER.email, CHECKER.password, CHECKER.secret, "SG", "staff");
  const support = await login(SUPPORT.email, SUPPORT.password, SUPPORT.secret, "SG", "staff");
  assert(risk.status === 200 && ops.status === 200 && checker.status === 200 && support.status === 200, "staff login");
  const riskAuth = { authorization: `Bearer ${risk.data.token}` };
  const opsAuth = { authorization: `Bearer ${ops.data.token}` };
  const checkerAuth = { authorization: `Bearer ${checker.data.token}` };
  const supportAuth = { authorization: `Bearer ${support.data.token}` };
  assert(String(demo.setCookie).includes("meridex_customer="), `customer cookie ${demo.setCookie}`);
  assert(String(admin.setCookie).includes("meridex_staff=") && String(admin.setCookie).includes("Path=/api/admin"), `staff cookie ${admin.setCookie}`);
  const cookieHit = await call("/api/admin/users", {}, { cookie: `meridex_customer=${token}` });
  assert(cookieHit.status === 403 && cookieHit.data.error === "CUSTOMER_SESSION", `customer cookie on admin ${cookieHit.status} ${JSON.stringify(cookieHit.data)}`);
  const staffOnDesk = await call("/api/me", {}, { authorization: `Bearer ${admin.data.token}` });
  assert(staffOnDesk.status === 403 && staffOnDesk.data.error === "STAFF_SESSION", `staff token on customer ${staffOnDesk.status}`);
  note("session_split=1");

  const deniedRisk = await call("/api/admin/risk/dashboard", {}, authz);
  const deniedOps = await call("/api/admin/ops/reports", {}, riskAuth);
  const deniedSupport = await call("/api/admin/ops/reports", {}, supportAuth);
  assert(deniedRisk.status === 403 && deniedOps.status === 403 && deniedSupport.status === 403, `rbac ${deniedRisk.status} ${deniedOps.status} ${deniedSupport.status}`);
  const inbox = await call("/api/admin/support/inbox", {}, supportAuth);
  assert(inbox.status === 200 && Array.isArray(inbox.data.threads), `support inbox ${inbox.status}`);
  note("rbac=1");

  const me = await call("/api/me", {}, authz);
  const demoId = Number(me.data.id);
  await call("/api/admin/risk/rules/spoof", { method: "POST", body: JSON.stringify({ threshold: 2, enabled: true }) }, riskAuth);
  for (let i = 0; i < 2; i++) {
    const observed = await call(
      "/api/admin/risk/observe",
      { method: "POST", body: JSON.stringify({ userId: demoId, kind: "cancel", symbol: "XAU/USD" }) },
      riskAuth,
    );
    assert(observed.status === 200, `observe ${observed.status}`);
  }
  const customerObserve = await call(
    "/api/admin/risk/observe",
    { method: "POST", body: JSON.stringify({ userId: demoId, kind: "cancel" }) },
    authz,
  );
  assert(customerObserve.status === 403, `customer observe ${customerObserve.status}`);
  const dash = await call("/api/admin/risk/dashboard", {}, riskAuth);
  const survAlerts = (dash.data.alerts as { rule_id: string; demo: boolean }[]) ?? [];
  assert(dash.status === 200 && survAlerts.some((row) => row.rule_id === "spoof" && row.demo === false), `spoof alert ${JSON.stringify(survAlerts.slice(0, 4))}`);
  assert(survAlerts.some((row) => row.demo === true), "demo bot alerts missing");
  await call("/api/admin/risk/rules/spoof", { method: "POST", body: JSON.stringify({ threshold: 8, enabled: true }) }, riskAuth);
  const caseView = await call("/api/admin/risk/cases/case-wash", {}, riskAuth);
  assert(caseView.status === 200 && Array.isArray(caseView.data.notes), `case ${caseView.status}`);
  const noted = await call(
    "/api/admin/risk/cases/case-wash",
    { method: "POST", body: JSON.stringify({ action: "note", body: "验收备注" }) },
    riskAuth,
  );
  assert(noted.status === 200 && (noted.data.notes as unknown[]).length >= 2, `case note ${noted.status}`);
  note("surveillance=1");

  const proposed = await call(
    "/api/admin/ops/changes",
    { method: "POST", body: JSON.stringify({ kind: "fee_schedule", payload: { vipTier: "standard", makerBps: 11, takerBps: 21 } }) },
    opsAuth,
  );
  assert(proposed.status === 200 && proposed.data.status === "pending", `propose ${proposed.status} ${JSON.stringify(proposed.data)}`);
  const selfApprove = await call(
    `/api/admin/ops/changes/${proposed.data.id}`,
    { method: "POST", body: JSON.stringify({ action: "approve", reason: "self" }) },
    opsAuth,
  );
  assert(selfApprove.status === 403 && selfApprove.data.error === "MAKER_CHECKER", `maker ${selfApprove.status} ${JSON.stringify(selfApprove.data)}`);
  const approved = await call(
    `/api/admin/ops/changes/${proposed.data.id}`,
    { method: "POST", body: JSON.stringify({ action: "approve", reason: "checker" }) },
    checkerAuth,
  );
  assert(approved.status === 200 && approved.data.status === "approved", `checker ${approved.status}`);
  const overview = await call("/api/admin/ops/overview", {}, opsAuth);
  const standard = ((overview.data.fees as { vip_tier: string; maker_bps: number }[]) ?? []).find((row) => row.vip_tier === "standard");
  assert(standard?.maker_bps === 11, `fee ${JSON.stringify(overview.data.fees)}`);
  const revert = await call(
    "/api/admin/ops/changes",
    { method: "POST", body: JSON.stringify({ kind: "fee_schedule", payload: { vipTier: "standard", makerBps: 10, takerBps: 10 } }) },
    opsAuth,
  );
  await call(`/api/admin/ops/changes/${revert.data.id}`, { method: "POST", body: JSON.stringify({ action: "approve", reason: "restore" }) }, checkerAuth);
  const csv = await call("/api/admin/ops/reports.csv", {}, opsAuth);
  assert(csv.status === 200 && String(csv.data.raw ?? "").includes("dau") || String(JSON.stringify(csv.data)).includes("dau"), `csv ${csv.status}`);
  note("maker_checker=1");

  const founder = await login(OWNER.email, OWNER.password, OWNER.secret, "SG", "staff");
  assert(founder.status === 200, `founder login ${founder.status}`);
  const founderAuth = { authorization: `Bearer ${founder.data.token}` };
  const ownChange = await call(
    "/api/admin/ops/changes",
    { method: "POST", body: JSON.stringify({ kind: "announcement", payload: { title: "自审公告", body: "超级管理员自行通过", banner: false } }) },
    founderAuth,
  );
  assert(ownChange.status === 200 && ownChange.data.status === "pending", `founder propose ${ownChange.status} ${JSON.stringify(ownChange.data)}`);
  const ownApprove = await call(
    `/api/admin/ops/changes/${ownChange.data.id}`,
    { method: "POST", body: JSON.stringify({ action: "approve", reason: "super-admin" }) },
    founderAuth,
  );
  assert(ownApprove.status === 200 && ownApprove.data.status === "approved", `founder self approve ${ownApprove.status} ${JSON.stringify(ownApprove.data)}`);
  const changeAudit = await call("/api/admin/ops/audit", {}, founderAuth);
  const changeEvents = (changeAudit.data.events as { kind: string; detail: string }[]) ?? [];
  assert(
    changeEvents.some((row) => row.kind === "change_approve" && String(row.detail).includes(String(ownChange.data.id)) && String(row.detail).includes("\"self\":true")),
    `change audit ${JSON.stringify(changeEvents[0])}`,
  );
  note("super_admin=1");

  const step = totp(DEMO.secret);
  const phish = await call("/api/account/phishing", { method: "POST", body: JSON.stringify({ code: "MERIDEX7", stepUp: step }) }, authz);
  assert(phish.status === 200, `phishing ${phish.status} ${JSON.stringify(phish.data)}`);
  const weak = await call(
    "/api/account/password",
    { method: "POST", body: JSON.stringify({ current: DEMO.password, next: "password", stepUp: totp(DEMO.secret) }) },
    authz,
  );
  assert(weak.status === 400 && weak.data.error === "WEAK_PASSWORD", `weak ${weak.status} ${JSON.stringify(weak.data)}`);
  const breached = await call(
    "/api/account/password",
    { method: "POST", body: JSON.stringify({ current: DEMO.password, next: "Password123!", stepUp: totp(DEMO.secret) }) },
    authz,
  );
  assert(breached.status === 400 && breached.data.error === "BREACHED_PASSWORD", `breach ${breached.status} ${JSON.stringify(breached.data)}`);
  const listed = await call(
    "/api/account/whitelist",
    { method: "POST", body: JSON.stringify({ asset: "BTC", address: "bc1qmeridexdemoaddress01", label: "desk", stepUp: totp(DEMO.secret) }) },
    authz,
  );
  assert(listed.status === 200 && listed.data.status === "locked", `whitelist ${listed.status} ${JSON.stringify(listed.data)}`);
  const lockedWd = await call(
    "/api/wallet/crypto",
    { method: "POST", body: JSON.stringify({ asset: "BTC", network: "Bitcoin", direction: "withdraw", amount: "0.001", address: "bc1qmeridexdemoaddress01", stepUp: totp(DEMO.secret) }) },
    authz,
  );
  assert(lockedWd.status === 403 && lockedWd.data.error === "WHITELIST_LOCKED", `lock ${lockedWd.status} ${JSON.stringify(lockedWd.data)}`);
  const box = await call("/api/notifications", {}, authz);
  const messages = (box.data.messages as { body: string; provider: string; channel: string }[]) ?? [];
  assert(box.status === 200 && messages.some((row) => row.channel === "email" && row.provider === "mock-email" && row.body.includes("MERIDEX7")), `outbox ${JSON.stringify(messages[0])}`);
  const noStep = await call("/api/account/keys", { method: "POST", body: JSON.stringify({ label: "nostep" }) }, authz);
  assert(noStep.status === 401 && noStep.data.error === "STEP_UP_REQUIRED", `step ${noStep.status}`);
  const readKey = await call(
    "/api/account/keys",
    { method: "POST", body: JSON.stringify({ label: "read", scopes: "read,withdraw", stepUp: totp(DEMO.secret) }) },
    authz,
  );
  assert(readKey.status === 200 && readKey.data.scopes === "read" && !String(readKey.data.scopes).includes("withdraw"), `scopes ${JSON.stringify(readKey.data)}`);
  async function signed(method: string, path: string, secret: string, key: string, body?: Record<string, unknown>, headers: Record<string, string> = {}) {
    const ts = String(Date.now());
    const raw = body ? JSON.stringify(body) : "";
    return call(path, { method, body: raw || undefined }, {
      "x-api-key": key,
      "x-api-timestamp": ts,
      "x-api-sign": signV1(secret, ts, method, path, raw),
      ...headers,
    });
  }
  const publicBook = await call("/api/v1/market/book?symbol=XAU/USD");
  assert(publicBook.status === 200 && publicBook.data.symbol === "XAU/USD", `v1 book ${publicBook.status}`);
  const balances = await signed("GET", "/api/v1/balances", readKey.data.secret as string, readKey.data.id as string);
  assert(balances.status === 200, `signed balances ${balances.status} ${JSON.stringify(balances.data)}`);
  const noTrade = await signed("POST", "/api/v1/orders", readKey.data.secret as string, readKey.data.id as string, {});
  assert(noTrade.status === 403 && noTrade.data.error === "SCOPE_DENIED", `scope ${noTrade.status} ${JSON.stringify(noTrade.data)}`);
  const tradeKey = await call(
    "/api/account/keys",
    { method: "POST", body: JSON.stringify({ label: "trade", scopes: "trade", stepUp: totp(DEMO.secret) }) },
    authz,
  );
  const tradeScope = await signed("POST", "/api/v1/orders", tradeKey.data.secret as string, tradeKey.data.id as string, {});
  assert(tradeScope.status === 400 && tradeScope.data.error === "VALIDATION", `trade scope ${tradeScope.status}`);
  const noWithdraw = await signed("POST", "/api/v1/withdraw", tradeKey.data.secret as string, tradeKey.data.id as string, {});
  assert(noWithdraw.status === 403 && noWithdraw.data.error === "SCOPE_DENIED", `withdraw scope ${noWithdraw.status}`);
  const ipKey = await call(
    "/api/account/keys",
    { method: "POST", body: JSON.stringify({ label: "ip", scopes: "read", ipWhitelist: "203.0.113.50", stepUp: totp(DEMO.secret) }) },
    authz,
  );
  const ipDenied = await signed("GET", "/api/v1/balances", ipKey.data.secret as string, ipKey.data.id as string);
  assert(ipDenied.status === 403 && ipDenied.data.error === "IP_DENIED", `ip ${ipDenied.status} ${JSON.stringify(ipDenied.data)}`);
  note("api_hmac=1");

  const frozen = await call("/api/account/freeze", { method: "POST", body: JSON.stringify({ frozen: true, reason: "acceptance", stepUp: totp(DEMO.secret) }) }, authz);
  assert(frozen.status === 200 && frozen.data.frozen === true, `freeze ${frozen.status}`);
  const frozenOrder = await call(
    "/api/orders",
    { method: "POST", body: JSON.stringify({ side: "buy", type: "limit", price: "100.00", quantity: "0.010", symbol: "XAU/USD" }) },
    authz,
  );
  assert(frozenOrder.status === 403 && frozenOrder.data.error === "ACCOUNT_FROZEN", `frozen order ${frozenOrder.status}`);
  const thawed = await call("/api/account/freeze", { method: "POST", body: JSON.stringify({ frozen: false, reason: "acceptance", stepUp: totp(DEMO.secret) }) }, authz);
  assert(thawed.status === 200 && thawed.data.frozen === false, `thaw ${thawed.status}`);
  note("whitelist_lock=1");

  const meiClaim = await call("/api/growth/claim", { method: "POST", body: JSON.stringify({ code: "MERIDEX-SG" }) }, meiAuth);
  assert(meiClaim.status === 200 || meiClaim.data.error === "VALIDATION", `claim ${meiClaim.status} ${JSON.stringify(meiClaim.data)}`);
  const growth = await call("/api/growth", {}, authz);
  const invites = (growth.data.invites as { invitee: string; commission_uusd: string }[]) ?? [];
  assert(growth.status === 200 && invites.some((row) => row.invitee === "mei.tan@meridexexchange.com"), `referral ${JSON.stringify(invites)}`);
  note("referral=1");

  const help = await call("/api/help?q=whitelist");
  assert(help.status === 200 && ((help.data.articles as unknown[]) ?? []).length >= 1, `help ${help.status}`);
  const spec = await call("/api/openapi.json");
  assert(spec.status === 200 && spec.data.openapi === "3.0.3", `openapi ${spec.status}`);
  note("notifications_outbox=1");

  const inv = await call("/api/admin/invariants", {}, { authorization: `Bearer ${admin.data.token}` });
  assert(inv.data.ok === true, `invariants ${JSON.stringify(inv.data)}`);
  const checks = inv.data.checks as { ok: boolean }[];
  note(`invariants_ok=${checks.filter((c) => c.ok).length}/${checks.length}`);

  const replay = await call("/api/admin/replay", { method: "POST", body: "{}" }, { authorization: `Bearer ${admin.data.token}` });
  assert(replay.status === 200 && replay.data.ok === true && replay.data.match === true, `replay ${replay.status} ${JSON.stringify(replay.data)}`);
  const books = (replay.data.books as { symbol: string; state_hash: string }[] | undefined) ?? [];
  for (const symbol of ["XAU/USD", "BTC/USD", "ETH/USD", "XAG/USD", "BRENT/USD"]) {
    const row = books.find((item) => item.symbol === symbol);
    assert(row && row.state_hash.length === 64, `replay book ${symbol} ${JSON.stringify(row)}`);
  }
  note(`replay_ok=1 hash=${replay.data.state_hash} books=${books.length}`);

  const owner = await login(OWNER.email, OWNER.password, OWNER.secret, "SG", "staff");
  assert(owner.status === 200 && owner.data.addressPoolOwner !== false, `owner login ${owner.status} ${JSON.stringify(owner.data)}`);
  const ownerAuth = { authorization: `Bearer ${owner.data.token}` };
  const poolLogin = await login(OWNER.email, OWNER.password, OWNER.secret, "SG", "pool");
  assert(poolLogin.status === 200 && poolLogin.data.portal === "pool", `pool login ${poolLogin.status} ${JSON.stringify(poolLogin.data)}`);
  const poolAuth = { authorization: `Bearer ${poolLogin.data.token}` };
  const meOwner = await call("/api/admin/me", {}, ownerAuth);
  assert(meOwner.data.addressPoolOwner === true, `owner flag ${JSON.stringify(meOwner.data)}`);
  const deniedPool = await call(
    "/api/admin/treasury/pool/import",
    { method: "POST", body: JSON.stringify({ totp: totp(ADMIN.secret), csv: "BTC,Bitcoin,tb1qnotreal,," }) },
    { authorization: `Bearer ${admin.data.token}` },
  );
  assert(deniedPool.status === 403 && deniedPool.data.error === "POOL_DESK", `admin import ${deniedPool.status} ${JSON.stringify(deniedPool.data)}`);
  const staffWrite = await call(
    "/api/admin/treasury/pool/import",
    { method: "POST", body: JSON.stringify({ totp: totp(OWNER.secret), csv: "BTC,Bitcoin,tb1qnotreal,," }) },
    ownerAuth,
  );
  assert(staffWrite.status === 403 && staffWrite.data.error === "POOL_DESK", `staff owner import ${staffWrite.status} ${JSON.stringify(staffWrite.data)}`);
  const missingTotp = await call(
    "/api/pool/treasury/pool/import",
    { method: "POST", body: JSON.stringify({ csv: "BTC,Bitcoin,tb1qnotreal,," }) },
    poolAuth,
  );
  assert(missingTotp.status === 401 && missingTotp.data.error === "TOTP_REQUIRED", `pool totp ${missingTotp.status}`);
  const poolN = 1000 + (Date.now() % 100000);
  const freshBtc = demoAddress("BTC", "Bitcoin", poolN);
  const imported = await call(
    "/api/pool/treasury/pool/import",
    {
      method: "POST",
      body: JSON.stringify({
        totp: totp(OWNER.secret),
        rows: [
          { asset: "BTC", network: "Bitcoin", address: "not-an-address" },
          { asset: "BTC", network: "Bitcoin", address: demoAddress("BTC", "Bitcoin", 1) },
          { asset: "BTC", network: "Bitcoin", address: freshBtc },
          { asset: "BTC", network: "Bitcoin", address: freshBtc },
        ],
      }),
    },
    poolAuth,
  );
  const rejected = (imported.data.rejected as { reason: string }[]) ?? [];
  assert(imported.status === 200 && imported.data.accepted === 1, `import ${imported.status} ${JSON.stringify(imported.data)}`);
  assert(rejected.some((row) => row.reason.includes("checksum") || row.reason.includes("bitcoin")), `checksum reject ${JSON.stringify(rejected)}`);
  assert(rejected.filter((row) => row.reason === "duplicate").length >= 1, `duplicate reject ${JSON.stringify(rejected)}`);
  const supportPool = await call("/api/admin/treasury/pool", {}, supportAuth);
  const ownerPool = await call("/api/admin/treasury/pool", {}, ownerAuth);
  assert(supportPool.status === 200 && ownerPool.status === 200, "pool read");
  const supportRows = supportPool.data.rows as { address: string; status: string }[];
  const ownerRows = ownerPool.data.rows as { id: number; address: string; email: string | null; asset: string; network: string; status: string }[];
  assert(supportRows.some((row) => row.address.includes("…")), `staff pool not masked ${JSON.stringify(supportRows[0])}`);
  assert(ownerRows.some((row) => row.address === freshBtc), "owner cannot see imported address");

  const instructions = await call("/api/wallet/deposit-instructions", {}, authz);
  const addresses = instructions.data.addresses as { asset: string; network: string; status: string; address: string | null }[];
  assert(instructions.status === 200 && addresses.length === 4, `instructions ${instructions.status} ${JSON.stringify(addresses)}`);
  assert(instructions.data.guidePath === "/funds/deposit", `deposit guide ${instructions.data.guidePath}`);
  const guided = addresses.find((row) => row.asset === "BTC") as { guidePath?: string } | undefined;
  assert(guided?.guidePath === "/funds/deposit?asset=BTC&network=Bitcoin", `btc guide ${guided?.guidePath}`);
  assert(addresses.every((row) => row.status === "ready" && row.address), `pool empty ${JSON.stringify(addresses)}`);
  const poolHk = await login("hk.chen@meridexexchange.com", DEMO.password, "<redacted>");
  const jp = await login("jp.sato@meridexexchange.com", DEMO.password, "<redacted>");
  const [hkIns, jpIns] = await Promise.all([
    call("/api/wallet/deposit-instructions", {}, { authorization: `Bearer ${poolHk.data.token}` }),
    call("/api/wallet/deposit-instructions", {}, { authorization: `Bearer ${jp.data.token}` }),
  ]);
  const hkBtc = ((hkIns.data.addresses as { asset: string; address: string }[]) ?? []).find((row) => row.asset === "BTC")?.address;
  const jpBtc = ((jpIns.data.addresses as { asset: string; address: string }[]) ?? []).find((row) => row.asset === "BTC")?.address;
  const demoBtc = addresses.find((row) => row.asset === "BTC")?.address;
  assert(demoBtc && hkBtc && jpBtc && new Set([demoBtc, hkBtc, jpBtc]).size === 3, `assignment collision ${demoBtc} ${hkBtc} ${jpBtc}`);
  const own = addresses.find((row) => row.asset === "USDT" && row.network === "TRC20");
  assert(own?.address, "missing usdt");
  const customerAddr = `0x${"ab".repeat(20)}`;
  const customerSaid = await call("/api/support/chat", { method: "POST", body: JSON.stringify({ body: `my sending wallet ${customerAddr}`, topic: "deposit" }) }, authz);
  assert(customerSaid.status === 200, `customer address blocked ${customerSaid.status} ${JSON.stringify(customerSaid.data)}`);
  const echoed = await call(
    "/api/admin/support/chat",
    { method: "POST", body: JSON.stringify({ userId: demoId, body: `received from ${customerAddr}` }) },
    supportAuth,
  );
  assert(echoed.status === 200, `linked echo ${echoed.status} ${JSON.stringify(echoed.data)}`);
  const echoedRows = echoed.data.messages as { body: string; masked: string }[];
  const echoedLast = echoedRows[echoedRows.length - 1];
  assert(echoedLast.body.includes(customerAddr) && echoedLast.masked.includes("…") && !echoedLast.masked.includes(customerAddr), `mask ${echoedLast.masked}`);
  const platformEcho = await call(
    "/api/admin/support/chat",
    { method: "POST", body: JSON.stringify({ userId: demoId, body: `your deposit address is ${own.address}` }) },
    supportAuth,
  );
  assert(platformEcho.status === 200, `pool address echo ${platformEcho.status} ${JSON.stringify(platformEcho.data)}`);
  const tx = `0x${"ab".repeat(32)}`;
  const txMsg = await call("/api/admin/support/chat", { method: "POST", body: JSON.stringify({ userId: demoId, body: `txid ${tx}` }) }, supportAuth);
  assert(txMsg.status === 200, `txid blocked ${txMsg.status} ${JSON.stringify(txMsg.data)}`);
  const spoof = await call(
    "/api/admin/support/chat",
    { method: "POST", body: JSON.stringify({ userId: demoId, body: "Verified by MERIDEX" }) },
    supportAuth,
  );
  const spoofRows = (spoof.data.messages as { kind: string; body: string }[]) ?? [];
  assert(spoof.status === 200 && spoofRows[spoofRows.length - 1].kind === "text", `spoof card ${spoof.status}`);
  const leaked = await call(
    "/api/admin/support/chat",
    { method: "POST", body: JSON.stringify({ userId: demoId, body: `send to 0x${"cd".repeat(20)}` }) },
    supportAuth,
  );
  assert(leaked.status === 422 && leaked.data.error === "PAYMENT_REDACTED", `unlinked ${leaked.status} ${JSON.stringify(leaked.data)}`);
  const typed = await call(
    "/api/admin/support/deposit-card",
    { method: "POST", body: JSON.stringify({ userId: demoId, asset: "USDT", network: "TRC20", address: `0x${"11".repeat(20)}` }) },
    supportAuth,
  );
  assert(typed.status === 400 && typed.data.error === "ADDRESS_NOT_ACCEPTED", `typed address ${typed.status}`);
  const card = await call(
    "/api/admin/support/deposit-card",
    { method: "POST", body: JSON.stringify({ userId: demoId, asset: "USDT", network: "TRC20" }) },
    supportAuth,
  );
  const cardRows = (card.data.messages as { kind: string; card?: { address?: string; verified?: boolean; issuer?: string; guidePath?: string } }[]) ?? [];
  const issued = cardRows.filter((row) => row.kind === "deposit_card").pop();
  assert(card.status === 200 && issued?.card?.verified === true && issued.card.issuer === "MERIDEX" && issued.card.address === own.address, `card ${card.status} ${issued?.card?.address}`);
  assert(issued?.card?.guidePath === "/funds/deposit?asset=USDT&network=TRC20", `card guide ${issued?.card?.guidePath}`);
  const livePool = await call("/api/admin/treasury/pool", {}, ownerAuth);
  const liveRows = (livePool.data.rows as { id: number; address: string; email: string | null; asset: string; network: string; status: string }[]) ?? [];
  const edited = liveRows.find((row) => row.email === DEMO.email && row.asset === "BTC" && row.status === "assigned");
  assert(livePool.status === 200 && edited, "demo btc assignment missing");
  const oldAddress = edited.address;
  const replacement = demoAddress("BTC", "Bitcoin", poolN + 1);
  const changed = await call(
    "/api/pool/treasury/pool/edit",
    { method: "POST", body: JSON.stringify({ totp: totp(OWNER.secret), id: edited.id, address: replacement }) },
    poolAuth,
  );
  assert(changed.status === 200, `edit ${changed.status} ${JSON.stringify(changed.data)}`);
  const after = await call("/api/wallet/deposit-instructions", {}, authz);
  const poolAfterBtc = ((after.data.addresses as { asset: string; address: string }[]) ?? []).find((row) => row.asset === "BTC")?.address;
  assert(poolAfterBtc === replacement, `funds still old ${poolAfterBtc}`);
  const attr = await call(`/api/admin/treasury/attribute?address=${encodeURIComponent(oldAddress)}`, {}, ownerAuth);
  const matches = (attr.data.matches as { email: string; active: boolean }[]) ?? [];
  assert(attr.status === 200 && matches.some((row) => row.email === DEMO.email && row.active === false), `history ${JSON.stringify(matches)}`);
  const notices = await call("/api/notifications", {}, authz);
  const noticeRows = (notices.data.messages as { title: string; body: string }[]) ?? [];
  assert(noticeRows.some((row) => row.title.includes("充值地址已更换")), `customer notice ${JSON.stringify(noticeRows.slice(0, 3))}`);
  const ownerNotes = await call("/api/admin/notifications", {}, ownerAuth);
  const ownerRowsN = (ownerNotes.data.messages as { title: string; body: string; email: string }[]) ?? [];
  assert(
    ownerRowsN.some((row) => row.email === OWNER.email && row.title.includes("充值地址变更") && row.body.includes(addressHash(oldAddress))),
    `owner alert ${ownerNotes.status} ${JSON.stringify(ownerRowsN.slice(0, 3))}`,
  );
  const audit = await call("/api/admin/treasury/audit", {}, { authorization: `Bearer ${admin.data.token}` });
  const events = (audit.data.events as { action: string; old_hash: string | null; new_hash: string | null; detail: string | null }[]) ?? [];
  const editEvent = events.find((row) => row.action === "edit" && row.new_hash === addressHash(replacement));
  assert(editEvent && editEvent.old_hash === addressHash(oldAddress), `audit ${JSON.stringify(events[0])}`);
  assert(!JSON.stringify(editEvent).includes(replacement), "audit stored the raw address");
  const poolRemoved = await call(
    "/api/pool/treasury/pool/delete",
    { method: "POST", body: JSON.stringify({ totp: totp(OWNER.secret), id: edited.id }) },
    poolAuth,
  );
  assert(poolRemoved.status === 409 && poolRemoved.data.error === "ADDRESS_IN_USE", `delete assigned ${poolRemoved.status}`);
  const low = await call(
    "/api/pool/treasury/pool/threshold",
    { method: "POST", body: JSON.stringify({ totp: totp(OWNER.secret), asset: "ETH", network: "Ethereum", threshold: 100 }) },
    poolAuth,
  );
  assert(low.status === 200, `threshold ${low.status} ${JSON.stringify(low.data)}`);
  const lowAudit = await call("/api/admin/treasury/audit", {}, ownerAuth);
  assert(((lowAudit.data.events as { action: string }[]) ?? []).some((row) => row.action === "low_stock"), "low stock missing");
  await call(
    "/api/pool/treasury/pool/threshold",
    { method: "POST", body: JSON.stringify({ totp: totp(OWNER.secret), asset: "ETH", network: "Ethereum", threshold: 2 }) },
    poolAuth,
  );
  const credited = await call("/api/wallet/deposit", { method: "POST", body: JSON.stringify({ asset: "USD", amount: "1.00" }) }, authz);
  assert(credited.status === 200, `deposit ${credited.status}`);
  const mine = await call("/api/wallet/deposits", {}, authz);
  const depositRows = (mine.data.deposits as { status: string; id: string }[]) ?? [];
  assert(depositRows.some((row) => row.status === "credited"), `deposit list ${JSON.stringify(depositRows.slice(0, 2))}`);
  const foundDep = await call(`/api/admin/support/deposits?q=${encodeURIComponent(String(instructions.data.referenceCode))}`, {}, supportAuth);
  assert(foundDep.status === 200 && ((foundDep.data.deposits as { email: string }[]) ?? []).every((row) => row.email === DEMO.email), `lookup ${foundDep.status}`);
  const enrol = await call("/api/admin/security/totp/start", { method: "POST", body: JSON.stringify({ totp: totp(OWNER.secret) }) }, ownerAuth);
  const recovery = (enrol.data.recoveryCodes as string[]) ?? [];
  assert(enrol.status === 200 && enrol.data.qrDataUrl && recovery.length === 8, `enrol ${enrol.status}`);
  for (let i = 0; i < 4; i += 1) {
    const bad = await call(
      "/api/pool/treasury/pool/import",
      { method: "POST", body: JSON.stringify({ totp: "000000", rows: [{ asset: "BTC", network: "Bitcoin", address: freshBtc }] }) },
      poolAuth,
    );
    assert(bad.status === 401 && bad.data.error === "INVALID_TOTP", `bad totp ${i} ${bad.status} ${JSON.stringify(bad.data)}`);
  }
  const poolLocked = await call(
    "/api/pool/treasury/pool/import",
    { method: "POST", body: JSON.stringify({ totp: "000000", rows: [{ asset: "BTC", network: "Bitcoin", address: freshBtc }] }) },
    poolAuth,
  );
  assert(poolLocked.status === 429 && poolLocked.data.error === "TOTP_LOCKED", `lockout ${poolLocked.status} ${JSON.stringify(poolLocked.data)}`);
  await releaseOwnerDemo(edited.id, oldAddress);
  const unlocked = await call(
    "/api/pool/treasury/pool/threshold",
    { method: "POST", body: JSON.stringify({ totp: totp(OWNER.secret), asset: "ETH", network: "Ethereum", threshold: 2 }) },
    poolAuth,
  );
  assert(unlocked.status === 200, `lockout not cleared ${unlocked.status} ${JSON.stringify(unlocked.data)}`);
  const restoredFunds = await call("/api/wallet/deposit-instructions", {}, authz);
  const restoredBtc = ((restoredFunds.data.addresses as { asset: string; address: string }[]) ?? []).find((row) => row.asset === "BTC")?.address;
  assert(restoredBtc === oldAddress, `demo btc not restored ${restoredBtc}`);
  note("address_pool=1");

  const marker = `验收标题${Date.now() % 100000}`;
  const forbiddenCopy = await call(
    "/api/admin/content/string",
    { method: "PUT", body: JSON.stringify({ key: "zh.heroTitle", value: marker }) },
    supportAuth,
  );
  assert(forbiddenCopy.status === 403, `support content ${forbiddenCopy.status}`);
  const setStr = await call(
    "/api/admin/content/string",
    { method: "PUT", body: JSON.stringify({ key: "zh.heroTitle", value: marker }) },
    ownerAuth,
  );
  assert(setStr.status === 200 && setStr.data.value === marker, `set copy ${setStr.status} ${JSON.stringify(setStr.data)}`);
  const pub = await call("/api/content");
  const overrides = (pub.data.overrides ?? {}) as Record<string, string>;
  assert(pub.status === 200 && overrides["zh.heroTitle"] === marker, `public copy ${pub.status} ${overrides["zh.heroTitle"]}`);
  const badNum = await call(
    "/api/admin/content/number",
    { method: "PUT", body: JSON.stringify({ key: "convert.feeBps", value: 9999 }) },
    ownerAuth,
  );
  assert(badNum.status === 400 && badNum.data.error === "VALIDATION", `range ${badNum.status} ${JSON.stringify(badNum.data)}`);
  const setNum = await call(
    "/api/admin/content/number",
    { method: "PUT", body: JSON.stringify({ key: "convert.feeBps", value: 12 }) },
    ownerAuth,
  );
  assert(setNum.status === 200 && setNum.data.value === 12, `set fee ${setNum.status} ${JSON.stringify(setNum.data)}`);
  const copyAudit = await call("/api/admin/content/audit", {}, ownerAuth);
  const copyEvents = (copyAudit.data.events as { key: string; old_value: string | null; new_value: string | null }[]) ?? [];
  const copyHit = copyEvents.find((row) => row.key === "zh.heroTitle" && row.new_value === marker);
  const feeHit = copyEvents.find((row) => row.key === "convert.feeBps" && row.new_value === "12");
  assert(copyAudit.status === 200 && copyHit && copyHit.old_value && copyHit.old_value !== marker, `copy audit ${JSON.stringify(copyHit)}`);
  assert(feeHit && feeHit.old_value === "10", `fee audit ${JSON.stringify(feeHit)}`);
  const resetCopy = await call(
    "/api/admin/content/string",
    { method: "DELETE", body: JSON.stringify({ key: "zh.heroTitle" }) },
    ownerAuth,
  );
  const resetFee = await call(
    "/api/admin/content/number",
    { method: "DELETE", body: JSON.stringify({ key: "convert.feeBps" }) },
    ownerAuth,
  );
  assert(resetCopy.status === 200 && resetFee.status === 200, `reset ${resetCopy.status} ${resetFee.status}`);
  const pubAfter = await call("/api/content");
  const afterOverrides = (pubAfter.data.overrides ?? {}) as Record<string, string>;
  const afterNumbers = (pubAfter.data.numbers ?? {}) as Record<string, number>;
  assert(pubAfter.status === 200 && afterOverrides["zh.heroTitle"] == null && afterNumbers["convert.feeBps"] === 10, `reset live ${JSON.stringify({ title: afterOverrides["zh.heroTitle"], fee: afterNumbers["convert.feeBps"] })}`);
  note("content=1");

  const reportsBefore = await call("/api/admin/ops/reports", {}, ownerAuth);
  const overviewBefore = await call("/api/admin/ops/overview", {}, ownerAuth);
  const practiceEmail = `staff.practice.${Date.now()}@meridexexchange.com`;
  const practiceBody = { email: practiceEmail, name: "Practice Desk", password: "<redacted>", totp: false };
  const denied = await call("/api/admin/internal-test", { method: "POST", body: JSON.stringify(practiceBody) }, { authorization: `Bearer ${admin.data.token}` });
  assert(denied.status === 403, `compliance cannot add staff test ${denied.status}`);
  const created = await call("/api/admin/internal-test", { method: "POST", body: JSON.stringify(practiceBody) }, ownerAuth);
  assert(created.status === 200 && created.data.badge === "INTERNAL TEST / 内部测试" && created.data.id, `create staff ${created.status} ${JSON.stringify(created.data)}`);
  const practiceId = Number(created.data.id);
  const shortReason = await call(
    `/api/admin/internal-test/${practiceId}/move`,
    { method: "POST", body: JSON.stringify({ direction: "credit", asset: "USD", amount: "10.00", reason: "no" }) },
    ownerAuth,
  );
  assert(shortReason.status === 400, `reason ${shortReason.status}`);
  const creditedPlay = await call(
    `/api/admin/internal-test/${practiceId}/move`,
    { method: "POST", body: JSON.stringify({ direction: "credit", asset: "USD", amount: "5000.00", reason: "staff practice float" }) },
    ownerAuth,
  );
  assert(creditedPlay.status === 200, `play credit ${creditedPlay.status} ${JSON.stringify(creditedPlay.data)}`);
  await new Promise((r) => setTimeout(r, 400));
  const practiceLogin = await call(
    "/api/auth/login",
    { method: "POST", body: JSON.stringify({ email: practiceEmail, password: "<redacted>" }) },
    { "x-mock-country": "SG" },
  );
  assert(practiceLogin.status === 200 && practiceLogin.data.token, `practice login ${practiceLogin.status} ${JSON.stringify(practiceLogin.data)}`);
  const practiceAuth = { authorization: `Bearer ${practiceLogin.data.token}`, "x-mock-country": "SG" };
  const practiceMe = await call("/api/me", {}, practiceAuth);
  assert(practiceMe.data.isInternalTest === true && practiceMe.data.badge === "INTERNAL TEST / 内部测试", `badge ${JSON.stringify(practiceMe.data)}`);
  const practiceDeposit = await call("/api/wallet/deposit", { method: "POST", body: JSON.stringify({ asset: "USD", amount: "10.00" }) }, practiceAuth);
  const practiceWithdraw = await call("/api/wallet/withdraw", { method: "POST", body: JSON.stringify({ asset: "USD", amount: "1.00", stepUp: "000000" }) }, practiceAuth);
  const practicePaper = await call("/api/paper", { method: "POST", body: JSON.stringify({ action: "enable" }) }, practiceAuth);
  const practiceConvert = await call("/api/convert/quote", { method: "POST", body: JSON.stringify({ symbol: "BTC/USD", side: "buy", quantity: "0.0001" }) }, practiceAuth);
  assert(practiceDeposit.status === 403 && practiceDeposit.data.error === "PLAY_ONLY", `deposit rail ${practiceDeposit.status} ${practiceDeposit.data.error}`);
  assert(practiceWithdraw.status === 403 && practiceWithdraw.data.error === "PLAY_ONLY", `withdraw rail ${practiceWithdraw.status}`);
  assert(practicePaper.status === 403 && practicePaper.data.error === "PLAY_ONLY", `paper ${practicePaper.status}`);
  assert(practiceConvert.status === 403 && practiceConvert.data.error === "PLAY_ONLY", `convert ${practiceConvert.status} ${practiceConvert.data.error}`);
  const btcBook = await call("/api/v1/market/book?symbol=BTC/USD");
  const ref = Number(btcBook.data.referencePrice);
  const limitUnits = Math.floor((ref * 0.97) / 100) * 100;
  const playRest = await call(
    "/api/orders",
    { method: "POST", body: JSON.stringify({ symbol: "BTC/USD", side: "buy", type: "limit", price: (limitUnits / 100).toFixed(2), quantity: "0.0001" }) },
    practiceAuth,
  );
  assert(playRest.status === 200 && playRest.data.status === "open", `play rest ${playRest.status} ${JSON.stringify(playRest.data)}`);
  const playFill = await call(
    "/api/orders",
    { method: "POST", body: JSON.stringify({ symbol: "BTC/USD", side: "buy", type: "market", quantity: "0.0001" }) },
    practiceAuth,
  );
  assert(playFill.status === 200 && playFill.data.status === "filled" && playFill.data.orderId, `play fill ${playFill.status} ${JSON.stringify(playFill.data)}`);
  const isolation = await practiceLedger(practiceId);
  assert(isolation.real_trades === 0 && isolation.real_orders === 0 && isolation.real_accounts === 0, `real ledger touched ${JSON.stringify(isolation)}`);
  assert(isolation.play_trades >= 1 && isolation.play_orders >= 2, `play ledger ${JSON.stringify(isolation)}`);
  const hidden = await call(`/api/admin/ops/users?q=${encodeURIComponent(practiceEmail)}`, {}, ownerAuth);
  const hiddenRows = (hidden.data.users as { email: string }[]) ?? [];
  assert(hidden.status === 200 && hiddenRows.every((row) => row.email !== practiceEmail), `search leaked ${JSON.stringify(hiddenRows)}`);
  const reportsAfter = await call("/api/admin/ops/reports", {}, ownerAuth);
  const overviewAfter = await call("/api/admin/ops/overview", {}, ownerAuth);
  assert(reportsAfter.data.funded === reportsBefore.data.funded, `funded ${reportsBefore.data.funded} -> ${reportsAfter.data.funded}`);
  assert(reportsAfter.data.dau === reportsBefore.data.dau, `dau ${reportsBefore.data.dau} -> ${reportsAfter.data.dau}`);
  assert(overviewAfter.data.customers === overviewBefore.data.customers, `customers ${overviewBefore.data.customers} -> ${overviewAfter.data.customers}`);
  const playList = await call("/api/admin/internal-test", {}, ownerAuth);
  const practiceRow = ((playList.data.accounts as { email: string; badge: string }[]) ?? []).find((row) => row.email === practiceEmail);
  assert(playList.status === 200 && practiceRow?.badge === "INTERNAL TEST / 内部测试", `internal list ${playList.status}`);
  const disabled = await call(`/api/admin/internal-test/${practiceId}/disabled`, { method: "POST", body: JSON.stringify({ disabled: true }) }, ownerAuth);
  assert(disabled.status === 200 && disabled.data.disabled === true, `disable ${disabled.status}`);
  await new Promise((r) => setTimeout(r, 400));
  const blockedLogin = await call(
    "/api/auth/login",
    { method: "POST", body: JSON.stringify({ email: practiceEmail, password: "<redacted>" }) },
    { "x-mock-country": "SG" },
  );
  assert(blockedLogin.status === 403 && blockedLogin.data.error === "ACCOUNT_DISABLED", `disabled login ${blockedLogin.status} ${blockedLogin.data.error}`);
  const practiceGone = await call(`/api/admin/internal-test/${practiceId}`, { method: "DELETE" }, ownerAuth);
  assert(practiceGone.status === 200 && practiceGone.data.deleted === true, `delete ${practiceGone.status} ${JSON.stringify(practiceGone.data)}`);
  note("internal_test=1");

  console.log("ACCEPTANCE_OK");
  console.log(results.join("\n"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
