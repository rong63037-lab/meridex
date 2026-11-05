/**
 * Public reference depth. Parsers and the fallback chain run offline.
 * The switch check needs the gateway. Leaves the switch OFF.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { totp } from "../gateway/src/crypto.ts";
import {
  cleanNumber,
  hostAllowed,
  isStale,
  parseBinanceBook,
  parseBinanceTrades,
  parseCoinbaseBook,
  parseFrankfurter,
  parseGeckoPrice,
  parseGoldPrice,
  parseKrakenBook,
  publicUrls,
  readPublicDepth,
  spotSymbol,
  type Grab,
} from "../gateway/src/referenceDepth.ts";
import { getInstrument } from "../gateway/src/instruments.ts";

const require = createRequire(new URL("../gateway/package.json", import.meta.url));
const { Pool } = require("pg") as {
  Pool: new (cfg: { connectionString: string }) => {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    end: () => Promise<void>;
  };
};

const base = process.env.GATEWAY_URL ?? "http://127.0.0.1:7108";
const dbUrl = process.env.DATABASE_URL ?? "postgres://meridex:<redacted>@127.0.0.1:5432/meridex";
const FOUNDER = { email: "founder@meridexexchange.com", password: "<redacted>", secret: "<redacted>" };
const SUPPORT = { email: "support@meridexexchange.com", password: "<redacted>", secret: "<redacted>" };

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
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

async function login(email: string, password: string, secret: string) {
  let last = await call("/api/admin/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password, totp: totp(secret) }),
  });
  for (let i = 0; i < 6 && last.status === 429; i += 1) {
    await sleep(1000);
    last = await call("/api/admin/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password, totp: totp(secret) }),
    });
  }
  assert.equal(last.status, 200, `login ${email} ${last.status} ${JSON.stringify(last.data)}`);
  assert.equal(typeof last.data.token, "string");
  return String(last.data.token);
}

function offline() {
  assert.equal(spotSymbol("xau-perp"), "XAU/USD");
  assert.equal(spotSymbol("BTC/USD"), "BTC/USD");
  assert.equal(cleanNumber("1.5000"), "1.5");
  assert.equal(cleanNumber(0), null);
  assert.equal(isStale(1_000, 6_000, 4_000), true);
  assert.equal(isStale(5_000, 6_000, 4_000), false);
  assert.equal(hostAllowed("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"), true);
  assert.equal(hostAllowed("http://api.binance.com/api/v3/order"), false);
  assert.equal(hostAllowed("https://evil.example/order"), false);

  const btc = getInstrument("BTC/USD");
  const urls = publicUrls(btc);
  assert.ok(urls.some((row) => row.url.includes("/api/v3/depth?")));
  assert.ok(urls.some((row) => row.url.includes("coingecko.com") && row.kind === "price"));
  assert.ok(urls.every((row) => row.url.startsWith("https://") && hostAllowed(row.url)));
  assert.ok(urls.every((row) => !/\/order/i.test(row.url)));
  const source = readFileSync(new URL("../gateway/src/referenceDepth.ts", import.meta.url), "utf8");
  assert.match(source, /method: "GET"/);
  assert.doesNotMatch(source, /method: "POST"/);

  const book = parseBinanceBook({ bids: [["100.00", "0.2"]], asks: [["101.50", "0.1"]] });
  assert.equal(book?.bids[0]?.price, "100");
  const prints = parseBinanceTrades([{ price: "100", qty: "0.1", time: 1_700_000_000_000, isBuyerMaker: true }]);
  assert.equal(prints.trades[0]?.side, "sell");
  const coin = parseCoinbaseBook({ pricebook: { bids: [{ price: "9", size: "1" }], asks: [{ price: "10", size: "2" }], time: "2026-01-01T00:00:00.000Z" } });
  assert.equal(coin?.asks[0]?.price, "10");
  const kraken = parseKrakenBook({ result: { XXBTZUSD: { bids: [["100", "1", 1_700_000_000]], asks: [["101", "1", 1_700_000_001]] } } });
  assert.equal(kraken?.bids.length, 1);
  assert.equal(parseGeckoPrice({ bitcoin: { usd: 64000.5 } }, "bitcoin"), "64000.5");
  assert.equal(parseGoldPrice({ price: 2650.12 }), "2650.12");
  const fx = parseFrankfurter({ rates: { EUR: 0.92 } }, "EUR");
  assert.ok(fx && Number(fx) > 1, `fx ${fx}`);

  const gold = getInstrument("XAU/USD");
  assert.ok(publicUrls(gold).every((row) => row.source === "gold-api" && row.kind === "price"));
  const eur = getInstrument("EUR/USD");
  assert.ok(publicUrls(eur).every((row) => row.source === "frankfurter"));
}

async function chain() {
  const btc = getInstrument("BTC/USD");
  const calls: string[] = [];
  const grab: Grab = async (url) => {
    calls.push(url);
    if (url.includes("/depth?")) return { bids: [["64000", "0.5"]], asks: [["64010", "0.4"]] };
    if (url.includes("/trades?")) return [{ price: "64005", qty: "0.01", time: Date.now(), isBuyerMaker: false }];
    if (url.includes("coingecko")) return { bitcoin: { usd: 1 } };
    return null;
  };
  const book = await readPublicDepth(btc, grab);
  assert.equal(book.source, "binance");
  assert.equal(book.kind, "book");
  assert.equal(book.bids[0]?.size, "0.5");
  assert.equal(book.unit, "BTC");
  assert.ok(calls.some((url) => url.includes("coingecko")));

  const fallback: Grab = async (url) => (url.includes("coingecko") ? { bitcoin: { usd: 63000 } } : null);
  const price = await readPublicDepth(btc, fallback);
  assert.equal(price.source, "coingecko");
  assert.equal(price.kind, "price");
  assert.equal(price.bids.length, 0);
  assert.equal(price.asks.length, 0);
  assert.equal(price.price, "63000");

  const gold = await readPublicDepth(getInstrument("XAU/USD"), async (url) => (url.includes("gold-api") ? { price: 2400 } : null));
  assert.equal(gold.kind, "price");
  assert.equal(gold.unit, "oz");
  assert.equal(gold.price, "2400");
  const kilo = await readPublicDepth(getInstrument("XAUKG/USD"), async () => ({ price: 3100 }));
  assert.equal(kilo.unit, "kg");
  assert.ok(Number(kilo.price) > 90_000, kilo.price ?? "");

  const down = await readPublicDepth(btc, async () => null);
  assert.equal(down.kind, "none");
  assert.equal(down.bids.length, 0);
}

async function main() {
  offline();
  await chain();
  const term = readFileSync(new URL("../web/app/terminal/page.tsx", import.meta.url), "utf8");
  const chart = readFileSync(new URL("../web/components/CandleChart.tsx", import.meta.url), "utf8");
  assert.match(term, /limit=300/);
  assert.match(term, /30_000/);
  assert.match(term, /<ReferenceDepth/);
  assert.match(term, /<Ticket/);
  assert.match(chart, /candle\.update/);
  assert.match(chart, /requestAnimationFrame/);

  const db = new Pool({ connectionString: dbUrl });
  const founder = await login(FOUNDER.email, FOUNDER.password, FOUNDER.secret);
  const support = await login(SUPPORT.email, SUPPORT.password, SUPPORT.secret);
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const before = await db.query(`SELECT count(*)::int AS n FROM reference_depth_audit`);
  const start = Number(before.rows[0]?.n ?? 0);
  try {
    const hidden = await call("/api/market/reference?symbol=BTC/USD");
    assert.equal(hidden.status, 200);
    assert.equal(hidden.data.enabled, false);
    assert.equal("bids" in hidden.data, false);

    const empty = await call("/api/admin/reference-depth", {
      method: "POST",
      body: JSON.stringify({ enabled: true, totp: "" }),
    }, auth(founder));
    assert.equal(empty.status, 401);
    assert.equal(empty.data.error, "TOTP_REQUIRED");
    const still = await db.query(`SELECT count(*)::int AS n FROM reference_depth_audit`);
    assert.equal(Number(still.rows[0]?.n ?? 0), start);

    const denied = await call("/api/admin/reference-depth", {
      method: "POST",
      body: JSON.stringify({ enabled: true, totp: totp(SUPPORT.secret) }),
    }, auth(support));
    assert.equal(denied.status, 403);

    const on = await call("/api/admin/reference-depth", {
      method: "POST",
      body: JSON.stringify({ enabled: true, totp: totp(FOUNDER.secret) }),
    }, auth(founder));
    assert.equal(on.status, 200, JSON.stringify(on.data));
    assert.equal(on.data.enabled, true);
    const opened = await db.query(`SELECT count(*)::int AS n FROM reference_depth_audit`);
    assert.equal(Number(opened.rows[0]?.n ?? 0), start + 1);

    const live = await call("/api/market/reference?symbol=BTC/USD");
    assert.equal(live.status, 200);
    assert.equal(live.data.enabled, true);
    assert.ok(live.data.kind === "book" || live.data.kind === "price" || live.data.kind === "none", `kind ${live.data.kind}`);
    if (live.data.kind === "book") {
      assert.ok(["binance", "coinbase", "kraken"].includes(String(live.data.source)), String(live.data.source));
      const bids = live.data.bids as { price?: string }[];
      const asks = live.data.asks as { price?: string }[];
      assert.ok(bids.length + asks.length > 0, "empty book");
    }
    if (live.data.kind === "price") {
      assert.ok(["coingecko", "gold-api", "frankfurter"].includes(String(live.data.source)), String(live.data.source));
      assert.equal((live.data.bids as unknown[]).length, 0);
      assert.equal(typeof live.data.price, "string");
    }
    assert.equal(live.data.spot, "BTC/USD");
    assert.equal(typeof live.data.staleAfterMs, "number");
    const perp = await call("/api/market/reference?symbol=BTC-PERP");
    assert.equal(perp.status, 200);
    assert.equal(perp.data.spot, "BTC/USD");
    assert.equal(perp.data.symbol, "BTC-PERP");
    console.log(`reference live source=${live.data.source} kind=${live.data.kind}`);

    const off = await call("/api/admin/reference-depth", {
      method: "POST",
      body: JSON.stringify({ enabled: false, totp: totp(FOUNDER.secret) }),
    }, auth(founder));
    assert.equal(off.status, 200);
    assert.equal(off.data.enabled, false);
    const again = await call("/api/market/reference?symbol=BTC/USD");
    assert.equal(again.data.enabled, false);
  } finally {
    await call("/api/admin/reference-depth", {
      method: "POST",
      body: JSON.stringify({ enabled: false, totp: totp(FOUNDER.secret) }),
    }, auth(founder));
    await db.end();
  }

  const check = new Pool({ connectionString: dbUrl });
  const flag = await check.query(`SELECT enabled FROM reference_depth WHERE id = 1`);
  const products = await check.query(`SELECT product, enabled FROM live_products ORDER BY product`);
  const providers = await check.query(`SELECT name, enabled FROM lp_providers ORDER BY name`);
  const kill = await check.query(`SELECT stopped FROM lp_kill WHERE id = 1`);
  const paper = await check.query(`SELECT enabled FROM paper_wallets WHERE user_id = 1`);
  assert.equal(flag.rows[0]?.enabled, false);
  assert.ok(products.rows.every((row) => row.enabled === false), "product switch was turned on");
  assert.ok(providers.rows.every((row) => row.enabled === false), "provider was turned on");
  assert.equal(kill.rows[0]?.stopped, false);
  assert.equal(paper.rows[0]?.enabled, false);
  await check.end();
  console.log("reference-depth ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
