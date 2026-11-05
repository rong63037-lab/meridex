/**
 * Test-venue adapters. Local mock servers only. No real keys and no demo hosts.
 * Providers, the kill switch, product switches, and the demo paper wallet are put back.
 */
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { totp } from "../gateway/src/crypto.ts";
import { createPool } from "../gateway/src/db.ts";
import { liquidityOverview, testProvider } from "../gateway/src/liquidity/admin.ts";
import { BinanceDemoFutures } from "../gateway/src/liquidity/binanceDemo.ts";
import { CoinbaseSandboxStub } from "../gateway/src/liquidity/coinbaseSandbox.ts";
import { binanceDemoBase, saxoSimBase } from "../gateway/src/liquidity/hosts.ts";
import { loadProviders } from "../gateway/src/liquidity/registry.ts";
import { logShadow, sendHedge } from "../gateway/src/liquidity/route.ts";
import { SaxoSim } from "../gateway/src/liquidity/saxoSim.ts";
import { LpError, type ProviderRow } from "../gateway/src/liquidity/types.ts";

const require = createRequire(new URL("../gateway/package.json", import.meta.url));
const { Pool } = require("pg") as typeof import("pg");

const base = process.env.GATEWAY_URL ?? "http://127.0.0.1:7108";
const dbUrl = process.env.DATABASE_URL ?? "postgres://meridex:<redacted>@127.0.0.1:5432/meridex";
const FOUNDER = { email: "founder@meridexexchange.com", password: "<redacted>", secret: "<redacted>" };
const SUPPORT = { email: "support@meridexexchange.com", password: "<redacted>", secret: "<redacted>" };

const KEY = "bd-key-canary-39";
const SECRET = "bd-secret-canary-39";
const TOKEN = "sx-token-canary-39";
const ACCOUNT = "sx-account-canary-39";

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

type Hit = { method: string; path: string };

function listen(onReq: (req: IncomingMessage, res: ServerResponse, hits: Hit[]) => void): Promise<{ url: string; hits: Hit[]; close: () => Promise<void> }> {
  const hits: Hit[] = [];
  const server = createServer((req, res) => onReq(req, res, hits));
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        hits,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function signedOk(url: URL, header: string | undefined): boolean {
  if (header !== KEY) return false;
  const sig = url.searchParams.get("signature") ?? "";
  const params = new URLSearchParams(url.searchParams);
  params.delete("signature");
  const expect = createHmac("sha256", SECRET).update(params.toString()).digest("hex");
  return sig === expect && sig.length === 64;
}

async function call(path: string, init: RequestInit = {}, token = "") {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "x-mock-country": "SG",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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

function leaked(value: unknown): boolean {
  const text = JSON.stringify(value);
  return text.includes(KEY) || text.includes(SECRET) || text.includes(TOKEN) || text.includes(ACCOUNT);
}

async function main() {
  for (const file of [
    "gateway/src/liquidity/binanceDemo.ts",
    "gateway/src/liquidity/saxoSim.ts",
    "gateway/src/liquidity/coinbaseSandbox.ts",
    "gateway/src/liquidity/envfile.ts",
    "gateway/src/liquidity/http.ts",
    "gateway/src/liquidity/hosts.ts",
  ]) {
    const text = readFileSync(join("/workspace", file), "utf8");
    assert(!/\bconsole\.(log|info|debug|warn|error)\b/.test(text), `${file} logs`);
  }

  assert(binanceDemoBase("").ok && binanceDemoBase("").base === "https://demo-fapi.binance.com", "demo default");
  assert(!binanceDemoBase("https://fapi.binance.com").ok, "prod fapi refused");
  assert(!binanceDemoBase("https://testnet.binancefuture.com").ok, "old testnet refused");
  assert(!binanceDemoBase("https://api.binance.com").ok, "spot prod refused");
  assert(binanceDemoBase("https://demo-fapi.binance.com/").ok, "demo host");
  assert(!saxoSimBase("https://gateway.saxobank.com/openapi").ok, "saxo live refused");
  assert(saxoSimBase("https://gateway.saxobank.com/sim/openapi").ok, "saxo sim");

  const dir = mkdtempSync(join(tmpdir(), "meridex-secrets-"));
  const saved = {
    key: process.env.BINANCE_DEMO_API_KEY,
    secret: process.env.BINANCE_DEMO_API_SECRET,
    token: process.env.SAXO_SIM_TOKEN,
    account: process.env.SAXO_SIM_ACCOUNT_KEY,
    secretsDir: process.env.MERIDEX_SECRETS_DIR,
  };
  delete process.env.BINANCE_DEMO_API_KEY;
  delete process.env.BINANCE_DEMO_API_SECRET;
  delete process.env.SAXO_SIM_TOKEN;
  delete process.env.SAXO_SIM_ACCOUNT_KEY;
  process.env.MERIDEX_SECRETS_DIR = dir;
  writeFileSync(join(dir, "binance-demo.env"), `BINANCE_DEMO_API_KEY=${KEY}\nBINANCE_DEMO_API_SECRET=${SECRET}\n`, { mode: 0o600 });
  writeFileSync(join(dir, "saxo-sim.env"), `SAXO_SIM_TOKEN=${TOKEN}\nSAXO_SIM_ACCOUNT_KEY=${ACCOUNT}\n`, { mode: 0o600 });

  const binance = await listen((req, res, hits) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    hits.push({ method: req.method ?? "", path: url.pathname });
    if (url.pathname === "/fapi/v1/ticker/bookTicker") {
      send(res, 200, { bidPrice: "100.50", askPrice: "100.70" });
      return;
    }
    if (!signedOk(url, req.headers["x-mbx-apikey"])) {
      send(res, 401, { code: -2015, msg: "rejected" });
      return;
    }
    if (url.pathname === "/fapi/v2/balance") {
      send(res, 200, [{ asset: "USDT", availableBalance: "1.5" }]);
      return;
    }
    if (url.pathname === "/fapi/v1/order" && req.method === "POST") {
      send(res, 200, { orderId: 42, status: "FILLED", executedQty: "0.01", avgPrice: "100.50" });
      return;
    }
    if (url.pathname === "/fapi/v1/order") {
      send(res, 200, { orderId: 42, status: "FILLED", executedQty: "0.01", avgPrice: "100.50" });
      return;
    }
    send(res, 404, { code: -1 });
  });

  let saxoMode: "ok" | "expired" = "ok";
  const saxoRefs: string[] = [];
  const saxo = await listen(async (req, res, hits) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    hits.push({ method: req.method ?? "", path: url.pathname });
    const auth = req.headers.authorization ?? "";
    if (saxoMode === "expired" || auth !== `Bearer ${TOKEN}`) {
      send(res, 401, { error: "expired" });
      return;
    }
    if (url.pathname === "/port/v1/balances/me") {
      send(res, 200, { CashBalance: 250.5, Currency: "USD" });
      return;
    }
    if (url.pathname === "/trade/v1/infoprices") {
      send(res, 200, { Quote: { Bid: 1.1, Ask: 1.2 } });
      return;
    }
    if (url.pathname === "/trade/v2/orders" && req.method === "POST") {
      const raw = await readBody(req);
      const body = JSON.parse(raw) as { AccountKey?: string; ExternalReference?: string };
      if (body.AccountKey !== ACCOUNT) {
        send(res, 400, {});
        return;
      }
      send(res, 201, { OrderId: "ord-1" });
      saxoRefs.push(String(body.ExternalReference ?? ""));
      return;
    }
    if (url.pathname === "/port/v1/orders/me") {
      send(res, 200, { Data: [{ OrderId: "ord-1", ExternalReference: saxoRefs[0] ?? "", Status: "Filled" }] });
      return;
    }
    send(res, 404, {});
  });

  const coin = await listen((_req, res, hits) => {
    hits.push({ method: "ANY", path: "/" });
    send(res, 200, {});
  });

  const pool = new Pool({ connectionString: dbUrl });
  const gw = createPool(dbUrl);
  const defaults = {
    "binance-demo": "https://demo-fapi.binance.com",
    "saxo-sim": "https://gateway.saxobank.com/sim/openapi",
    "coinbase-sandbox": "https://api-public.sandbox.exchange.coinbase.com",
  };
  async function restore() {
    for (const [name, url] of Object.entries(defaults)) {
      await pool.query(
        `UPDATE lp_providers SET enabled = false, mode = 'off', base_url = $2,
           per_order_notional_uusd = 0, daily_notional_uusd = 0 WHERE name = $1`,
        [name, url],
      );
    }
    await pool.query(`UPDATE lp_kill SET stopped = false WHERE id = 1`);
  }

  try {
    const providers = await loadProviders(gw);
    const binanceRow = providers.find((row) => row.name === "binance-demo");
    const saxoRow = providers.find((row) => row.name === "saxo-sim");
    const coinRow = providers.find((row) => row.name === "coinbase-sandbox");
    assert(binanceRow && saxoRow && coinRow, "migration 023 rows");
    assert(!binanceRow.enabled && binanceRow.mode === "off", "binance starts off");
    assert(!saxoRow.enabled && saxoRow.mode === "off", "saxo starts off");
    assert(!coinRow.enabled && coinRow.mode === "off", "coinbase starts off");

    const user = await pool.query(`SELECT id FROM users WHERE email = $1`, [FOUNDER.email]);
    const userId = Number(user.rows[0].id);

    const localBinance: ProviderRow = { ...binanceRow, baseUrl: binance.url };
    const driver = new BinanceDemoFutures(localBinance);
    const quote = await driver.quote("BTCUSDT");
    assert(quote && quote.bid === 10050n && quote.ask === 10070n, "binance quote scale");
    const probe = await driver.probe();
    assert(probe.ok && probe.error === "" && probe.latencyMs >= 0, "binance probe");
    assert(binance.hits.some((hit) => hit.path === "/fapi/v2/balance" && hit.method === "GET"), "balance read");
    assert(!binance.hits.some((hit) => hit.method === "POST"), "probe sent an order");

    binance.hits.length = 0;
    await logShadow(gw, localBinance, {
      userId, venue: "spot", asset: "BTC", symbol: "BTC/USD", side: "buy",
      qty: 1_000_000n, internalPx: 10000n, filledQty: 1_000_000n, status: "filled",
    });
    assert(binance.hits.some((hit) => hit.method === "GET"), "shadow quoted");
    assert(!binance.hits.some((hit) => hit.method === "POST"), "shadow posted");

    binance.hits.length = 0;
    const liveRow: ProviderRow = {
      ...localBinance,
      perOrderNotionalUusd: 10n ** 12n,
      dailyNotionalUusd: 10n ** 12n,
    };
    const hedged = await sendHedge(gw, { kind: "live", provider: liveRow, failover: null }, {
      userId, venue: "perp", asset: "BTC", symbol: "BTC/USD", side: "buy",
      qty: 1_000_000n, limitPx: null, notionalUusd: 2_000_000n, internalPx: null,
      qtyScale: 100_000_000, priceScale: 100, quoteScale: 1_000_000,
    });
    assert(hedged.sent === true && hedged.filledQty === 1_000_000n, "live-to-test filled");
    assert(binance.hits.filter((hit) => hit.method === "POST").length === 1, "one order post");
    const status = await driver.status(hedged.clientOrderId);
    assert(status?.status === "filled", "order status");

    const origFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetches += 1;
      return origFetch(...args);
    }) as typeof fetch;
    try {
      const refused = new BinanceDemoFutures({ ...localBinance, baseUrl: "https://fapi.binance.com" });
      let code = "";
      try {
        await refused.place({ clientOrderId: "nope", symbol: "BTCUSDT", side: "buy", qty: 1n, price: null });
      } catch (err) {
        code = err instanceof LpError ? err.code : "";
      }
      assert(code === "HOST_REFUSED" && fetches === 0, "production place did not open a socket");
      const missingDir = mkdtempSync(join(tmpdir(), "meridex-empty-"));
      process.env.MERIDEX_SECRETS_DIR = missingDir;
      fetches = 0;
      const bare = new BinanceDemoFutures(localBinance);
      let missing = "";
      try {
        await bare.place({ clientOrderId: "nokey", symbol: "BTCUSDT", side: "buy", qty: 1n, price: null });
      } catch (err) {
        missing = err instanceof LpError ? err.code : "";
      }
      assert(missing === "KEY_MISSING" && fetches === 0, "missing key did not open a socket");
      const blocked = await sendHedge(gw, { kind: "live", provider: { ...liveRow, baseUrl: "https://fapi.binance.com" }, failover: null }, {
        userId, venue: "perp", asset: "BTC", symbol: "BTC/USD", side: "buy",
        qty: 1_000_000n, limitPx: null, notionalUusd: 2_000_000n, internalPx: null,
        qtyScale: 100_000_000, priceScale: 100, quoteScale: 1_000_000,
      });
      assert(blocked.sent === false, "refused host was recorded as sent");
      rmSync(missingDir, { recursive: true, force: true });
    } finally {
      globalThis.fetch = origFetch;
      process.env.MERIDEX_SECRETS_DIR = dir;
    }

    await pool.query(`UPDATE lp_providers SET base_url = $1 WHERE name = 'binance-demo'`, [binance.url]);

    saxoMode = "expired";
    const saxoLocal: ProviderRow = { ...saxoRow, baseUrl: saxo.url };
    const expired = await new SaxoSim(saxoLocal).probe();
    assert(expired.ok === false && expired.error === "TOKEN_EXPIRED", "token expired");
    assert(!saxo.hits.some((hit) => hit.method === "POST"), "expired probe posted");

    saxoMode = "ok";
    saxo.hits.length = 0;
    const sim = new SaxoSim(saxoLocal);
    const simProbe = await sim.probe();
    assert(simProbe.ok, "saxo probe");
    const placed = await sim.place({ clientOrderId: "saxo-1", symbol: "FxSpot:21", side: "buy", qty: 100n, price: null });
    assert(placed.providerOrderId === "ord-1", "saxo order id");
    assert(saxo.hits.filter((hit) => hit.method === "POST").length === 1, "saxo one post");
    const saxoStatus = await sim.status("saxo-1");
    assert(saxoStatus?.status === "filled", "saxo status");

    const beforeCoin = coin.hits.length;
    const stub = new CoinbaseSandboxStub();
    assert((await stub.quote("BTC-USD")) === null, "stub quote");
    const stubProbe = await stub.probe();
    assert(stubProbe.error === "STUB" && stubProbe.ok === false, "stub probe");
    let stubCode = "";
    try {
      await stub.place({ clientOrderId: "c", symbol: "BTC-USD", side: "buy", qty: 1n, price: null });
    } catch (err) {
      stubCode = err instanceof LpError ? err.code : "";
    }
    assert(stubCode === "LP_DOCS_REQUIRED", "stub place");
    assert(coin.hits.length === beforeCoin, "stub opened a socket");

    const tested = await testProvider(gw, binanceRow.id);
    assert(tested.ok === true && tested.key === "present" && tested.error === "", "in-process test connection");
    assert(!leaked(tested), "probe payload leaked a secret");
    const overview = await liquidityOverview(gw);
    const card = (overview.providers as { name: string; key: string; latencyMs: number | null; lastError: string }[]).find((row) => row.name === "binance-demo");
    assert(card && card.key === "present" && card.latencyMs != null && card.lastError === "", "overview latency");
    assert(!leaked(overview), "overview leaked a secret");
    const saxoCard = (overview.providers as { name: string; key: string }[]).find((row) => row.name === "saxo-sim");
    const coinCard = (overview.providers as { name: string; key: string; healthDetail: string }[]).find((row) => row.name === "coinbase-sandbox");
    assert(saxoCard?.key === "present", "saxo key present");
    assert(coinCard?.key === "missing" && coinCard.healthDetail === "STUB", "coinbase stays missing");

    await pool.query(`UPDATE lp_providers SET base_url = $1 WHERE name = 'binance-demo'`, [defaults["binance-demo"]]);

    const founder = await login(FOUNDER.email, FOUNDER.password, FOUNDER.secret);
    const support = await login(SUPPORT.email, SUPPORT.password, SUPPORT.secret);
    const noTotp = await call(`/api/admin/liquidity/providers/${binanceRow.id}/test`, { method: "POST", body: "{}" }, support);
    assert(noTotp.status === 200, `test connection ${noTotp.status}`);
    assert(noTotp.data.error === "KEY_MISSING" && noTotp.data.ok === false, "gateway has no key file");
    assert(!leaked(noTotp.data), "http probe leaked a secret");
    const founderProbe = await call(`/api/admin/liquidity/providers/${saxoRow.id}/test`, { method: "POST", body: "{}" }, founder);
    assert(founderProbe.status === 200 && founderProbe.data.error === "KEY_MISSING", "founder probe without totp");

    const body = {
      mode: "off",
      enabled: false,
      spreadMarkupBps: binanceRow.spreadMarkupBps,
      minQty: binanceRow.minQty.toString(),
      maxQty: binanceRow.maxQty.toString(),
      perOrderNotionalUusd: "0",
      dailyNotionalUusd: "0",
      priority: binanceRow.priority,
      symbolMap: binanceRow.symbolMap,
      baseUrl: "https://fapi.binance.com",
      totp: totp(FOUNDER.secret),
    };
    const refusedSave = await call(`/api/admin/liquidity/providers/${binanceRow.id}`, { method: "POST", body: JSON.stringify(body) }, founder);
    assert(refusedSave.status === 400 && refusedSave.data.error === "HOST_REFUSED", "save refused production");
    const still = await pool.query(`SELECT base_url FROM lp_providers WHERE name = 'binance-demo'`);
    assert(still.rows[0].base_url === "https://demo-fapi.binance.com", "base url changed");
  } finally {
    if (saved.secretsDir === undefined) delete process.env.MERIDEX_SECRETS_DIR;
    else process.env.MERIDEX_SECRETS_DIR = saved.secretsDir;
    if (saved.key === undefined) delete process.env.BINANCE_DEMO_API_KEY;
    else process.env.BINANCE_DEMO_API_KEY = saved.key;
    if (saved.secret === undefined) delete process.env.BINANCE_DEMO_API_SECRET;
    else process.env.BINANCE_DEMO_API_SECRET = saved.secret;
    if (saved.token === undefined) delete process.env.SAXO_SIM_TOKEN;
    else process.env.SAXO_SIM_TOKEN = saved.token;
    if (saved.account === undefined) delete process.env.SAXO_SIM_ACCOUNT_KEY;
    else process.env.SAXO_SIM_ACCOUNT_KEY = saved.account;
    await restore().catch(() => undefined);
    await pool.query(`DELETE FROM lp_fills WHERE client_order_id IN (SELECT client_order_id FROM lp_routes WHERE provider_id IN (SELECT id FROM lp_providers WHERE name IN ('binance-demo','saxo-sim','coinbase-sandbox')))`).catch(() => undefined);
    await pool.query(`DELETE FROM lp_routes WHERE provider_id IN (SELECT id FROM lp_providers WHERE name IN ('binance-demo','saxo-sim','coinbase-sandbox'))`).catch(() => undefined);
    await binance.close();
    await saxo.close();
    await coin.close();
    rmSync(dir, { recursive: true, force: true });
    const off = await pool.query(`SELECT count(*)::int AS n FROM lp_providers WHERE enabled OR mode <> 'off'`);
    const kill = await pool.query(`SELECT stopped FROM lp_kill WHERE id = 1`);
    const switches = await pool.query(`SELECT enabled FROM live_products`);
    const paper = await pool.query(`SELECT enabled FROM paper_wallets WHERE user_id = 1`);
    const urls = await pool.query(`SELECT name, base_url FROM lp_providers WHERE name IN ('binance-demo','saxo-sim','coinbase-sandbox') ORDER BY name`);
    await pool.end();
    await gw.end();
    assert(off.rows[0].n === 0, "a provider was left on");
    assert(kill.rows[0].stopped === false, "kill left on");
    assert(switches.rows.every((row: { enabled: boolean }) => row.enabled === false), "product switch on");
    assert(paper.rows.length === 0 || paper.rows[0].enabled === false, "paper left on");
    const got = Object.fromEntries(urls.rows.map((row: { name: string; base_url: string }) => [row.name, row.base_url]));
    assert(got["binance-demo"] === defaults["binance-demo"], "binance url");
    assert(got["saxo-sim"] === defaults["saxo-sim"], "saxo url");
    assert(got["coinbase-sandbox"] === defaults["coinbase-sandbox"], "coinbase url");
  }
  console.log("lp adapters ok");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : "lp adapters failed");
  process.exit(1);
});
