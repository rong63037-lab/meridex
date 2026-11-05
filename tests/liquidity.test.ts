/**
 * Liquidity phase 1. The mock contract does not use the network.
 * Routing, TOTP, and the ledger run against the local database.
 * Providers are put back to off and the kill switch is cleared.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { totp } from "../gateway/src/crypto.ts";
import { createPool, withTx } from "../gateway/src/db.ts";
import { checkInvariants, deposit, postLpSpot } from "../gateway/src/ledger.ts";
import { clearAlertMemory } from "../gateway/src/liquidity/alerts.ts";
import { liquidityOverview } from "../gateway/src/liquidity/admin.ts";
import { FixSkeleton } from "../gateway/src/liquidity/fix.ts";
import { medianIndex, pickMark } from "../gateway/src/liquidity/mark.ts";
import { MockLiquidityProvider } from "../gateway/src/liquidity/mock.ts";
import { injectProvider, loadProviders, resetProviderCache } from "../gateway/src/liquidity/registry.ts";
import { RestSkeleton } from "../gateway/src/liquidity/rest.ts";
import { logShadow, planRoute, sendHedge } from "../gateway/src/liquidity/route.ts";
import { keyPresence } from "../gateway/src/liquidity/secrets.ts";
import { LpError, type ProviderRow } from "../gateway/src/liquidity/types.ts";

const require = createRequire(new URL("../gateway/package.json", import.meta.url));
const { Pool } = require("pg") as typeof import("pg");

const base = process.env.GATEWAY_URL ?? "http://127.0.0.1:7108";
const dbUrl = process.env.DATABASE_URL ?? "postgres://meridex:<redacted>@127.0.0.1:5432/meridex";
const FOUNDER = { email: "founder@meridexexchange.com", password: "<redacted>", secret: "<redacted>" };
const SUPPORT = { email: "support@meridexexchange.com", password: "<redacted>", secret: "<redacted>" };

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

let recover: (() => Promise<void>) | null = null;

async function call(path: string, init: RequestInit = {}, token = "") {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "x-mock-country": "SG",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data: data as Record<string, unknown> };
}

async function login(email: string, password: string, secret: string) {
  const res = await call("/api/admin/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password, totp: totp(secret) }),
  });
  assert(res.status === 200, `login ${email} ${res.status}`);
  return String(res.data.token);
}

function skeletonRow(type: "rest" | "fix"): ProviderRow {
  return {
    id: 0, name: type, type, baseUrl: "", secretRef: "", enabled: false, mode: "off", priority: 1,
    spreadMarkupBps: 0, minQty: 0n, maxQty: 0n, perOrderNotionalUusd: 0n, dailyNotionalUusd: 0n, symbolMap: {},
  };
}

async function main() {
  const mock = new MockLiquidityProvider("contract");
  mock.quotePx = 100n;
  const quote = await mock.quote("BTC/USD");
  assert(quote.bid === 99n && quote.ask === 101n, "quote");
  let seen = 0;
  const stop = mock.subscribe("BTC/USD", () => { seen += 1; });
  await new Promise((r) => setTimeout(r, 20));
  stop();
  assert(seen === 1, "subscribe");

  const full = await mock.place({ clientOrderId: "c1", symbol: "BTC/USD", side: "buy", qty: 10n, price: null });
  assert(full.status === "filled" && full.filledQty === 10n && full.fills.length === 1, "full fill");
  const again = await mock.place({ clientOrderId: "c1", symbol: "BTC/USD", side: "buy", qty: 10n, price: null });
  assert(again.fills.length === 1 && again.filledQty === 10n, "duplicate client order stays one order");
  assert((await mock.fills()).length === 1, "duplicate place did not add a fill");
  assert(mock.ingestFill(full.fills[0]) === null, "duplicate fill id ignored");

  mock.scenario = "partial";
  const partial = await mock.place({ clientOrderId: "c2", symbol: "BTC/USD", side: "buy", qty: 10n, price: null });
  assert(partial.status === "partial" && partial.filledQty === 5n, "partial");

  mock.scenario = "reject";
  const rejected = await mock.place({ clientOrderId: "c3", symbol: "BTC/USD", side: "buy", qty: 10n, price: null });
  assert(rejected.status === "rejected" && rejected.filledQty === 0n, "reject");

  mock.scenario = "disconnect";
  const dropped = await mock.place({ clientOrderId: "c4", symbol: "BTC/USD", side: "buy", qty: 10n, price: null });
  assert(dropped.status === "disconnected" && dropped.filledQty === 0n, "disconnect");
  assert((await mock.heartbeat()).ok === false, "heartbeat down");

  mock.scenario = "timeout";
  mock.disconnected = false;
  const timed = await mock.place({ clientOrderId: "c5", symbol: "BTC/USD", side: "buy", qty: 10n, price: null });
  assert(timed.status === "timeout" && timed.filledQty === 0n, "timeout");

  const slow = new MockLiquidityProvider("slow");
  slow.latencyMs = 200;
  slow.scenario = "fill";
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 30);
  const raced = await slow.place({ clientOrderId: "c6", symbol: "BTC/USD", side: "buy", qty: 4n, price: null }, ctrl.signal);
  assert(raced.status === "timeout" && raced.filledQty === 0n, "abort timeout does not fill");
  assert((await slow.fills()).length === 0, "aborted place stored no fill");

  const canceled = await mock.cancel("c3");
  assert(canceled.status === "canceled" || canceled.status === "rejected", "cancel");
  assert((await mock.balances()).length >= 1, "balances");
  assert((await mock.positions()).length >= 1, "positions");
  assert((await mock.status("c1"))?.filledQty === 10n, "status");

  const now = 1_000_000;
  const index = medianIndex(
    [
      { source: "a", px: 10_000n, at: now },
      { source: "b", px: 10_010n, at: now },
      { source: "c", px: 12_000n, at: now },
      { source: "d", px: 10_000n, at: now - 100_000 },
    ],
    now,
    30_000,
    100,
  );
  assert(index.mark === 10_005n, `median ${index.mark}`);
  assert(index.used.length === 2 && index.dropped.some((row) => row.source === "c"), "outlier dropped");
  assert(index.disagree, "disagree");
  const thin = medianIndex([{ source: "a", px: 10n, at: now }], now, 30_000, 100);
  assert(thin.mark === null, "one source does not make a mark");
  const drifted = pickMark(10_000n, 11_000n, 500);
  assert(!drifted.usedExternal && drifted.drifted, "book drift falls back");
  const close = pickMark(10_000n, 10_100n, 500);
  assert(close.usedExternal && close.px === 10_100n, "close external mark is used");

  const rest = new RestSkeleton(skeletonRow("rest"));
  const fix = new FixSkeleton(skeletonRow("fix"));
  let docs = 0;
  for (const driver of [rest, fix]) {
    assert((await driver.heartbeat()).detail === "LP_DOCS_REQUIRED", "skeleton health");
    assert((await driver.quote("BTC/USD")) === null, "skeleton has no invented quote");
    try {
      await driver.place({ clientOrderId: "x", symbol: "BTC/USD", side: "buy", qty: 1n, price: null });
    } catch (err) {
      assert(err instanceof LpError && err.code === "LP_DOCS_REQUIRED", "skeleton place");
      docs += 1;
    }
  }
  assert(docs === 2, "both skeletons refuse");

  const dir = mkdtempSync(join(tmpdir(), "lp-secrets-"));
  const file = join(dir, "lp-secrets.json");
  writeFileSync(file, JSON.stringify({ LP_FILE_ONLY: "file-canary-not-for-api" }));
  process.env.LP_SECRETS_FILE = file;
  assert(keyPresence("") === "unset", "unset ref");
  assert(keyPresence("LP_FILE_ONLY") === "present", "file key present");
  assert(keyPresence("LP_MISSING_KEY") === "missing", "missing key");
  delete process.env.LP_SECRETS_FILE;
  rmSync(dir, { recursive: true, force: true });

  const pool = new Pool({ connectionString: dbUrl });
  const gw = createPool(dbUrl);
  async function cleanup() {
    await pool.query(`DELETE FROM lp_fills`);
    await pool.query(`DELETE FROM lp_statements`);
    await pool.query(`DELETE FROM lp_routes`);
    await pool.query(`DELETE FROM lp_providers WHERE name = 'mock-b'`);
    await pool.query(`UPDATE lp_providers SET enabled = false, mode = 'off', per_order_notional_uusd = 0, daily_notional_uusd = 0`);
    await pool.query(`UPDATE lp_kill SET stopped = false WHERE id = 1`);
  }
  recover = cleanup;
  const founder = await login(FOUNDER.email, FOUNDER.password, FOUNDER.secret);
  const support = await login(SUPPORT.email, SUPPORT.password, SUPPORT.secret);
  const beforeAudit = await pool.query(`SELECT count(*)::int AS n FROM lp_audit`);
  const empty = await call("/api/admin/liquidity/providers/1", {
    method: "POST",
    body: JSON.stringify({ mode: "live", enabled: true, spreadMarkupBps: 0, minQty: "0", maxQty: "0", perOrderNotionalUusd: "1000000", dailyNotionalUusd: "1000000", priority: 10, symbolMap: {}, baseUrl: "", totp: "" }),
  }, founder);
  assert(empty.status === 401 && empty.data.error === "TOTP_REQUIRED", `empty totp ${empty.status}`);
  const afterEmpty = await pool.query(`SELECT count(*)::int AS n FROM lp_audit`);
  assert(afterEmpty.rows[0].n === beforeAudit.rows[0].n, "empty totp wrote an audit row");
  const supportTry = await call("/api/admin/liquidity/providers/1", {
    method: "POST",
    body: JSON.stringify({ mode: "shadow", enabled: true, spreadMarkupBps: 0, minQty: "0", maxQty: "0", perOrderNotionalUusd: "0", dailyNotionalUusd: "0", priority: 10, symbolMap: {}, baseUrl: "", totp: totp(SUPPORT.secret) }),
  }, support);
  assert(supportTry.status === 403, `support ${supportTry.status}`);

  const view = await call("/api/admin/liquidity", {}, founder);
  assert(view.status === 200, `overview ${view.status}`);
  const body = JSON.stringify(view.data);
  assert(!body.includes("canary") && !body.toLowerCase().includes("secret_value"), "overview leaked a secret");
  const listed = (view.data.providers as { name: string; mode: string; key: string }[]);
  assert(listed.some((row) => row.name === "mock" && row.mode === "off" && row.key === "missing"), "mock defaults off and key missing");

  process.env.LP_MOCK_KEY = "canary-secret-36";
  const localView = await liquidityOverview(gw);
  assert(localView.providers.find((row) => row.name === "mock")?.key === "present", "env key present");
  assert(!JSON.stringify(localView).includes("canary-secret-36"), "overview included the secret");
  delete process.env.LP_MOCK_KEY;

  const founderRow = await pool.query(`SELECT id FROM users WHERE email = $1`, [FOUNDER.email]);
  const userId = Number(founderRow.rows[0].id);
  const providers = await loadProviders(gw);
  const primary = providers.find((row) => row.name === "mock");
  assert(primary, "mock row");
  const shadowMock = new MockLiquidityProvider("shadow");
  shadowMock.quotePx = 50_000n;
  injectProvider(primary.id, shadowMock);
  await pool.query(`UPDATE lp_providers SET enabled = true, mode = 'shadow' WHERE id = $1`, [primary.id]);
  const shadowPlan = await planRoute(gw, { venue: "spot", asset: "BTC", userId });
  assert(shadowPlan.kind === "shadow", `shadow plan ${shadowPlan.kind}`);
  const places = shadowMock.placeCount;
  if (shadowPlan.kind === "shadow") {
    await logShadow(gw, shadowPlan.provider, {
      userId, venue: "spot", asset: "BTC", symbol: "BTC/USD", side: "buy", qty: 10n, internalPx: 50_000n, filledQty: 10n, status: "filled",
    });
  }
  assert(shadowMock.placeCount === places, "shadow called place");
  const shadowRow = await pool.query(`SELECT sent FROM lp_routes WHERE mode = 'shadow' ORDER BY id DESC LIMIT 1`);
  assert(shadowRow.rows[0].sent === false, "shadow row was sent");

  await pool.query(
    `INSERT INTO lp_providers (name, type, secret_ref, enabled, mode, priority, per_order_notional_uusd, daily_notional_uusd)
     VALUES ('mock-b', 'mock', 'LP_MOCK_B', true, 'live', 20, 1000000000000, 1000000000000)`,
  );
  await pool.query(
    `UPDATE lp_providers SET enabled = true, mode = 'live', per_order_notional_uusd = 1000000000000, daily_notional_uusd = 1000000000000 WHERE name = 'mock'`,
  );
  const liveRows = await loadProviders(gw);
  const liveA = liveRows.find((row) => row.name === "mock")!;
  const liveB = liveRows.find((row) => row.name === "mock-b")!;
  const rejector = new MockLiquidityProvider("rejector");
  rejector.scenario = "reject";
  const filler = new MockLiquidityProvider("filler");
  filler.scenario = "fill";
  filler.quotePx = 100n;
  injectProvider(liveA.id, rejector);
  injectProvider(liveB.id, filler);
  const hedge = await sendHedge(gw, { kind: "live", provider: liveA, failover: liveB }, {
    userId, venue: "spot", asset: "BTC", symbol: "BTC/USD", side: "buy", qty: 4n, limitPx: null,
    notionalUusd: 1_000_000n, internalPx: null, qtyScale: 100_000_000, priceScale: 100, quoteScale: 1_000_000,
  });
  assert(hedge.filledQty === 4n && hedge.failoverProviderId === liveB.id, "failover filled once");
  assert(rejector.placeCount === 1 && filler.placeCount === 1, "failover did not double-send");

  const partialA = new MockLiquidityProvider("partial-a");
  partialA.scenario = "partial";
  partialA.quotePx = 100n;
  const partialB = new MockLiquidityProvider("partial-b");
  partialB.scenario = "fill";
  injectProvider(liveA.id, partialA);
  injectProvider(liveB.id, partialB);
  const part = await sendHedge(gw, { kind: "live", provider: liveA, failover: liveB }, {
    userId, venue: "spot", asset: "BTC", symbol: "BTC/USD", side: "buy", qty: 8n, limitPx: null,
    notionalUusd: 1_000_000n, internalPx: null, qtyScale: 100_000_000, priceScale: 100, quoteScale: 1_000_000,
  });
  assert(part.filledQty === 4n && partialB.placeCount === 0, "partial did not fail over");

  const deadA = new MockLiquidityProvider("dead-a");
  deadA.scenario = "timeout";
  const deadB = new MockLiquidityProvider("dead-b");
  deadB.scenario = "reject";
  injectProvider(liveA.id, deadA);
  injectProvider(liveB.id, deadB);
  const none = await sendHedge(gw, { kind: "live", provider: liveA, failover: liveB }, {
    userId, venue: "spot", asset: "BTC", symbol: "BTC/USD", side: "sell", qty: 2n, limitPx: null,
    notionalUusd: 1_000_000n, internalPx: null, qtyScale: 100_000_000, priceScale: 100, quoteScale: 1_000_000,
  });
  assert(none.filledQty === 0n, "both rejects leave a zero fill");

  const killed = await call("/api/admin/liquidity/kill", { method: "POST", body: JSON.stringify({ stopped: true, totp: totp(FOUNDER.secret) }) }, founder);
  assert(killed.status === 200 && killed.data.kill === true, `kill ${killed.status}`);
  const killedPlan = await planRoute(gw, { venue: "spot", asset: "BTC", userId });
  assert(killedPlan.kind === "killed", "kill switch stops a new live route");

  const audit = await pool.query(`SELECT action FROM lp_audit WHERE actor_email = $1 ORDER BY id DESC LIMIT 5`, [FOUNDER.email]);
  assert(audit.rows.some((row) => row.action === "kill"), "kill audit missing");

  const dup = await pool.query(
    `INSERT INTO lp_fills (provider_id, fill_id, client_order_id, qty, px) VALUES ($1,'dup-36','dup-order',1,1)
     ON CONFLICT (provider_id, fill_id) DO NOTHING`,
    [liveA.id],
  );
  const dup2 = await pool.query(
    `INSERT INTO lp_fills (provider_id, fill_id, client_order_id, qty, px) VALUES ($1,'dup-36','dup-order',9,9)
     ON CONFLICT (provider_id, fill_id) DO NOTHING`,
    [liveA.id],
  );
  assert((dup.rowCount ?? 0) === 1 && (dup2.rowCount ?? 0) === 0, "fill id is idempotent in the database");
  const one = await pool.query(`SELECT qty::text FROM lp_fills WHERE fill_id = 'dup-36'`);
  assert(one.rows[0].qty === "1", "duplicate fill changed the quantity");

  const balancesBefore = await pool.query(`SELECT COALESCE(SUM(amount), 0)::text AS n FROM balances`);
  const csv = "fill_id,client_order_id,symbol,side,qty,px\nmissing-36,nope,BTC/USD,buy,1,1\ndup-36,dup-order,BTC/USD,buy,1,1\n";
  const imported = await call("/api/admin/liquidity/statements", {
    method: "POST",
    body: JSON.stringify({ providerId: liveA.id, csv }),
  }, founder);
  assert(imported.status === 200 && imported.data.breaks === 1 && imported.data.matched === 1, `import ${JSON.stringify(imported.data)}`);
  const balancesAfter = await pool.query(`SELECT COALESCE(SUM(amount), 0)::text AS n FROM balances`);
  assert(balancesBefore.rows[0].n === balancesAfter.rows[0].n, "statement import moved a balance");

  const email = `lp36.${Date.now()}@meridexexchange.com`;
  const registered = await call("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password: "<redacted>", residenceCountry: "SG" }),
  });
  assert(registered.status === 200, `register ${registered.status}`);
  const customerId = Number(registered.data.userId);
  const demo = await pool.query(`SELECT entity_id, jurisdiction FROM users WHERE email = 'client@meridexexchange.com'`);
  await pool.query(`UPDATE users SET entity_id = $2, jurisdiction = $3 WHERE id = $1`, [
    customerId,
    demo.rows[0].entity_id,
    demo.rows[0].jurisdiction,
  ]);
  const customer = { id: customerId, entityId: String(demo.rows[0].entity_id), jurisdiction: String(demo.rows[0].jurisdiction) };
  const orderId = `lp36-${customerId}`;
  await withTx(gw, async (client) => {
    await deposit(client, customer, "USD", 5_000_000n, { ref: orderId });
    await postLpSpot(client, customer, {
      orderId, symbol: "BTC/USD", base: "BTC", quote: "USD", side: "buy", orderType: "market",
      qty: 1_000n, price: 100n, notional: 1_000_000n, qtyScale: 100_000_000n, priceScale: 100n, quoteScale: 1_000_000n,
    });
  });
  const trade = await pool.query(`SELECT 1 FROM trades WHERE taker_order_id = $1 OR maker_order_id = $1`, [orderId]);
  assert((trade.rowCount ?? 0) === 0, "lp fill was inserted into trades");
  const held = await pool.query(`SELECT reserved_uusd::text, status FROM order_holds WHERE engine_order_id = $1`, [orderId]);
  assert(held.rows[0].status === "filled" && held.rows[0].reserved_uusd === "0", "lp hold reserved funds");
  const client = await gw.connect();
  try {
    const invariants = await checkInvariants(client);
    const bad = invariants.filter((row) => !row.ok);
    assert(bad.length === 0, `invariants ${bad.map((row) => row.name).join(",")}`);
  } finally {
    client.release();
  }

  await cleanup();
  const cleared = await call("/api/admin/liquidity/kill", { method: "POST", body: JSON.stringify({ stopped: false, totp: totp(FOUNDER.secret) }) }, founder);
  assert(cleared.status === 200 && cleared.data.kill === false, "kill left on");
  const off = await pool.query(`SELECT count(*)::int AS n FROM lp_providers WHERE enabled OR mode <> 'off'`);
  assert(off.rows[0].n === 0, "a provider was left on");
  const switches = await pool.query(`SELECT product, enabled FROM live_products ORDER BY product`);
  assert(switches.rows.every((row) => row.enabled === false), "product switch was turned on");
  clearAlertMemory();
  resetProviderCache();
  await pool.end();
  await gw.end();
  console.log("liquidity ok");
}

main().catch(async (err) => {
  console.error(err);
  if (recover) await recover().catch(() => undefined);
  process.exit(1);
});
