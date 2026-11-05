/**
 * Fee schedule. Whole basis points. Historical fill columns stay nullable.
 * Restores the regular spot maker rate if this test changes it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { totp } from "../gateway/src/crypto.ts";
import { feeOf } from "../gateway/src/fees.ts";

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

async function login() {
  let last = await call("/api/admin/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: FOUNDER.email, password: FOUNDER.password, totp: totp(FOUNDER.secret) }),
  });
  for (let i = 0; i < 6 && last.status === 429; i += 1) {
    await sleep(1000);
    last = await call("/api/admin/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: FOUNDER.email, password: FOUNDER.password, totp: totp(FOUNDER.secret) }),
    });
  }
  assert.equal(last.status, 200, `login ${last.status} ${JSON.stringify(last.data)}`);
  return String(last.data.token);
}

assert.equal(feeOf(1_000_000n, 10), 1_000n);
assert.equal(feeOf(1_000_000n, 2), 200n);
assert.equal(feeOf(1_000_000n, 5), 500n);
assert.equal(feeOf(100n, 10), 0n);

const desk = readFileSync(new URL("../web/components/DeskTicket.tsx", import.meta.url), "utf8");
const feesPage = readFileSync(new URL("../web/app/fees/page.tsx", import.meta.url), "utf8");
assert.doesNotMatch(desk, /binance/i);
assert.doesNotMatch(feesPage, /binance/i);
assert.match(desk, /data-testid="desk-ticket"/);

async function main() {
const pool = new Pool({ connectionString: dbUrl });
const spot0 = await pool.query(`SELECT maker_bps, taker_bps FROM fee_tiers WHERE product = 'spot' AND tier = 0`);
const perp0 = await pool.query(`SELECT maker_bps, taker_bps FROM fee_tiers WHERE product = 'perp' AND tier = 0`);
assert.equal(Number(spot0.rows[0]?.maker_bps), 10);
assert.equal(Number(spot0.rows[0]?.taker_bps), 10);
assert.equal(Number(perp0.rows[0]?.maker_bps), 2);
assert.equal(Number(perp0.rows[0]?.taker_bps), 5);
const named = await pool.query(`SELECT vip_tier, maker_bps, taker_bps FROM fee_schedules WHERE vip_tier = 'standard'`);
assert.equal(Number(named.rows[0]?.maker_bps), 10);
assert.equal(Number(named.rows[0]?.taker_bps), 10);
await pool.query(`SELECT buyer_fee_uusd, seller_fee_uusd FROM trades LIMIT 1`);
await pool.query(`SELECT fee_uusd FROM real_fills LIMIT 1`);

const owner = await login();
const auth = { authorization: `Bearer ${owner}` };
const tooBig = await call("/api/admin/content/number", { method: "PUT", body: JSON.stringify({ key: "fee.standard.makerBps", value: 9999, totp: totp(FOUNDER.secret) }) }, auth);
assert.equal(tooBig.status, 400);
assert.equal(tooBig.data.error, "VALIDATION");
const needsTotp = await call("/api/admin/content/number", { method: "PUT", body: JSON.stringify({ key: "fee.standard.makerBps", value: 11 }) }, auth);
assert.equal(needsTotp.status, 401);
assert.equal(needsTotp.data.error, "TOTP_REQUIRED");
const changed = await call("/api/admin/content/number", {
  method: "PUT",
  body: JSON.stringify({ key: "fee.standard.makerBps", value: 11, totp: totp(FOUNDER.secret) }),
}, auth);
assert.equal(changed.status, 200, JSON.stringify(changed.data));
const audit = await call("/api/admin/content/audit", {}, auth);
const events = (audit.data.events as { key?: string; new_value?: string }[] | undefined) ?? [];
assert.ok(events.some((row) => row.key === "fee.standard.makerBps" && row.new_value === "11"), "fee change missing from content_audit");
const restored = await call("/api/admin/content/number", {
  method: "PUT",
  body: JSON.stringify({ key: "fee.standard.makerBps", value: 10, totp: totp(FOUNDER.secret) }),
}, auth);
assert.equal(restored.status, 200, JSON.stringify(restored.data));
const after = await pool.query(`SELECT maker_bps FROM fee_tiers WHERE product = 'spot' AND tier = 0`);
assert.equal(Number(after.rows[0]?.maker_bps), 10);
const pub = await call("/api/fees");
const tiers = (pub.data.tiers as { product: string; tier: number; maker_bps: number; taker_bps: number }[]) ?? [];
const vip0 = tiers.find((row) => row.product === "spot" && row.tier === 0);
const p0 = tiers.find((row) => row.product === "perp" && row.tier === 0);
assert.equal(pub.status, 200);
assert.equal(vip0?.maker_bps, 10);
assert.equal(vip0?.taker_bps, 10);
assert.equal(p0?.maker_bps, 2);
assert.equal(p0?.taker_bps, 5);
assert.equal(pub.data.margin, "spot");
await pool.end();
console.log("fees ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
