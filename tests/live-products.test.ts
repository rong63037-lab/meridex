/**
 * Owner product switches, real margin/perp/copy ledger, caps, funding, and liquidation.
 * Runs against a gateway that is already up. Leaves every switch OFF.
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
const SUPPORT = { email: "support@meridexexchange.com", password: "<redacted>", secret: "<redacted>" };
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

async function main() {
  const db = new Pool({ connectionString: dbUrl });
  const founder = await login(FOUNDER.email, FOUNDER.password, FOUNDER.secret);
  const support = await login(SUPPORT.email, SUPPORT.password, SUPPORT.secret);
  const demo = await login(DEMO.email, DEMO.password, DEMO.secret, "customer");
  const stamp = Date.now().toString(36);
  const password = "<redacted>";
  let leaderId = 0;
  let followerId = 0;
  let leaderToken = "";
  let paperOn = false;
  let perpAllowed = false;

  async function setSwitch(product: string, enabled: boolean, maxNotionalUsd = "500.00", maxLeverage = 3) {
    const res = await call("/api/admin/live-products", {
      method: "POST",
      body: JSON.stringify({ product, enabled, maxNotionalUsd, maxLeverage, totp: totp(FOUNDER.secret) }),
    }, auth(founder));
    assert(res.status === 200, `switch ${product} ${enabled} ${res.status} ${JSON.stringify(res.data)}`);
    return res;
  }

  async function makeCustomer(prefix: string) {
    const email = `${prefix}.${stamp}@meridexexchange.com`;
    const registered = await call("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, residenceCountry: "SG" }),
    });
    assert(registered.status === 200, `register ${JSON.stringify(registered.data)}`);
    const userId = Number(registered.data.userId);
    const secret = String(registered.data.totpSecret);
    await db.query(`UPDATE users SET entity_id = 'SG-OPCO', jurisdiction = 'SG' WHERE id = $1`, [userId]);
    await db.query(
      `INSERT INTO kyc_profiles (user_id, nationality, residence_country, sanctions_hit, status, reason, entity_id)
       VALUES ($1,'SG','SG',false,'approved','sandbox','SG-OPCO')
       ON CONFLICT (user_id) DO UPDATE SET status = 'approved', entity_id = 'SG-OPCO', residence_country = 'SG'`,
      [userId],
    );
    const token = await login(email, password, secret, "customer");
    const funded = await call("/api/wallet/deposit", {
      method: "POST",
      body: JSON.stringify({ asset: "USD", amount: "200.00" }),
    }, auth(token));
    assert(funded.status === 200, `deposit ${funded.status} ${JSON.stringify(funded.data)}`);
    return { userId, token, email };
  }

  try {
    const off = await call("/api/perps/orders", {
      method: "POST",
      body: JSON.stringify({ symbol: "XAU-PERP", side: "buy", quantity: "0.100", leverage: 2 }),
    }, auth(demo));
    assert(off.status === 403 && off.data.error === "LIVE_OFF", `perp off ${off.status} ${JSON.stringify(off.data)}`);
    const marginOff = await call("/api/margin/orders", {
      method: "POST",
      body: JSON.stringify({ symbol: "XAU/USD", side: "buy", quantity: "0.100", leverage: 2 }),
    }, auth(demo));
    assert(marginOff.status === 403 && marginOff.data.error === "LIVE_OFF", `margin off ${JSON.stringify(marginOff.data)}`);
    const copyOff = await call("/api/copy/follow", {
      method: "POST",
      body: JSON.stringify({ leaderId: "1", allocation: "20.00", ratioBps: 10000, maxLoss: "10.00" }),
    }, auth(demo));
    assert(copyOff.status === 403 && copyOff.data.error === "LIVE_OFF", `copy off ${JSON.stringify(copyOff.data)}`);

    const auditBefore = await db.query(`SELECT count(*)::int AS n FROM live_product_audit`);
    const missing = await call("/api/admin/live-products", {
      method: "POST",
      body: JSON.stringify({ product: "perp", enabled: true, maxNotionalUsd: "500.00", maxLeverage: 3 }),
    }, auth(founder));
    assert(missing.status === 401 && missing.data.error === "TOTP_REQUIRED", `missing totp ${JSON.stringify(missing.data)}`);
    const bad = await call("/api/admin/live-products", {
      method: "POST",
      body: JSON.stringify({ product: "perp", enabled: true, maxNotionalUsd: "500.00", maxLeverage: 3, totp: "000000" }),
    }, auth(founder));
    assert(bad.status === 401 && bad.data.error === "INVALID_TOTP", `bad totp ${JSON.stringify(bad.data)}`);
    const auditAfter = await db.query(`SELECT count(*)::int AS n FROM live_product_audit`);
    assert(auditBefore.rows[0].n === auditAfter.rows[0].n, "bad totp wrote an audit row");
    const stranger = await call("/api/admin/live-products", {
      method: "POST",
      body: JSON.stringify({ product: "perp", enabled: true, maxNotionalUsd: "500.00", maxLeverage: 3, totp: totp(SUPPORT.secret) }),
    }, auth(support));
    assert(stranger.status === 403, `support switch ${stranger.status}`);

    await setSwitch("perp", true);
    await setSwitch("margin", true);
    await setSwitch("copy", true);
    const audited = await db.query(`SELECT count(*)::int AS n FROM live_product_audit`);
    assert(Number(audited.rows[0].n) >= Number(auditBefore.rows[0].n) + 3, "owner switch was not audited");

    const leader = await makeCustomer("livelead");
    const follower = await makeCustomer("livefol");
    leaderId = leader.userId;
    followerId = follower.userId;
    leaderToken = leader.token;

    const moved = await call("/api/wallets/transfer", {
      method: "POST",
      body: JSON.stringify({ from: "spot", to: "derivatives", amount: "80.00" }),
    }, auth(leader.token));
    assert(moved.status === 200, `transfer ${JSON.stringify(moved.data)}`);
    const spot = BigInt(String(moved.data.spotUusd));
    const deriv = BigInt(String(moved.data.derivativesUusd));
    assert(deriv === 80_000_000n, `derivatives ${deriv}`);
    assert(spot < 200_000_000n, "spot did not fall");

    const paperBefore = await db.query(`SELECT count(*)::int AS n FROM paper_perps WHERE user_id = $1`, [leaderId]);
    const opened = await call("/api/perps/orders", {
      method: "POST",
      body: JSON.stringify({ symbol: "XAU-PERP", side: "buy", quantity: "0.100", leverage: 2, orderType: "market" }),
    }, auth(leader.token));
    assert(opened.status === 200 && opened.data.status === "filled", `open ${opened.status} ${JSON.stringify(opened.data)}`);
    const paperAfter = await db.query(`SELECT count(*)::int AS n FROM paper_perps WHERE user_id = $1`, [leaderId]);
    assert(paperBefore.rows[0].n === paperAfter.rows[0].n, "real perp wrote a paper row");
    const board = await call("/api/perps", {}, auth(leader.token));
    assert(board.status === 200 && board.data.paper === false && board.data.live === true, `board ${JSON.stringify(board.data).slice(0, 300)}`);
    const positions = board.data.positions as { id: string; liq: string; upnlUusd: string; entry_px: string; mark: string }[];
    assert(positions.length === 1 && positions[0].liq && positions[0].entry_px && positions[0].mark, "position missing liq/entry/mark");

    const resting = await call("/api/perps/orders", {
      method: "POST",
      body: JSON.stringify({ symbol: "BTC-PERP", side: "buy", quantity: "0.0001", leverage: 2, orderType: "limit", price: "1.00" }),
    }, auth(leader.token));
    assert(resting.status === 200 && resting.data.status === "open", `limit ${JSON.stringify(resting.data)}`);
    const canceled = await call(`/api/perps/orders/${resting.data.id}/cancel`, { method: "POST", body: "{}" }, auth(leader.token));
    assert(canceled.status === 200 && canceled.data.status === "canceled", `cancel ${JSON.stringify(canceled.data)}`);

    const reduce = await call("/api/perps/orders", {
      method: "POST",
      body: JSON.stringify({ symbol: "ETH-PERP", side: "sell", quantity: "0.001", leverage: 2, reduceOnly: true }),
    }, auth(leader.token));
    assert(reduce.status === 409 && reduce.data.error === "REDUCE_ONLY", `reduce ${JSON.stringify(reduce.data)}`);

    const tooLev = await call("/api/perps/orders", {
      method: "POST",
      body: JSON.stringify({ symbol: "ETH-PERP", side: "buy", quantity: "0.001", leverage: 4 }),
    }, auth(leader.token));
    assert(tooLev.status === 409 && tooLev.data.error === "CAP_LEVERAGE", `lev ${JSON.stringify(tooLev.data)}`);

    await setSwitch("perp", true, "1.00", 3);
    const tooBig = await call("/api/perps/orders", {
      method: "POST",
      body: JSON.stringify({ symbol: "XAU-PERP", side: "buy", quantity: "0.100", leverage: 2 }),
    }, auth(leader.token));
    assert(tooBig.status === 409 && tooBig.data.error === "CAP_NOTIONAL", `cap ${JSON.stringify(tooBig.data)}`);
    await setSwitch("perp", true, "500.00", 3);

    const added = await call(`/api/perps/${positions[0].id}/margin`, {
      method: "POST",
      body: JSON.stringify({ action: "add", amount: "2.00" }),
    }, auth(leader.token));
    assert(added.status === 200, `add margin ${JSON.stringify(added.data)}`);

    await db.query(`UPDATE real_positions SET next_funding_at = now() - interval '1 minute' WHERE id = $1`, [positions[0].id]);
    const settled = await call("/api/admin/live-settle", {
      method: "POST",
      body: JSON.stringify({ totp: totp(FOUNDER.secret) }),
    }, auth(founder));
    assert(settled.status === 200, `settle ${JSON.stringify(settled.data).slice(0, 400)}`);
    const funding = await db.query(
      `SELECT count(*)::int AS n FROM real_fills WHERE user_id = $1 AND kind = 'funding'`,
      [leaderId],
    );
    assert(Number(funding.rows[0].n) >= 1, "funding did not post a fill");

    const marginMove = await call("/api/wallets/transfer", {
      method: "POST",
      body: JSON.stringify({ from: "spot", to: "margin", amount: "40.00" }),
    }, auth(leader.token));
    assert(marginMove.status === 200, `margin wallet ${JSON.stringify(marginMove.data)}`);
    const marginOpen = await call("/api/margin/orders", {
      method: "POST",
      body: JSON.stringify({ symbol: "BTC/USD", side: "sell", quantity: "0.0001", leverage: 2, orderType: "market", marginMode: "isolated" }),
    }, auth(leader.token));
    assert(marginOpen.status === 200 && marginOpen.data.status === "filled", `margin open ${JSON.stringify(marginOpen.data)}`);
    await db.query(
      `UPDATE real_positions SET next_funding_at = now() - interval '1 minute' WHERE user_id = $1 AND product = 'margin' AND status = 'open'`,
      [leaderId],
    );
    const interest = await call("/api/admin/live-settle", { method: "POST", body: JSON.stringify({ totp: totp(FOUNDER.secret) }) }, auth(founder));
    assert(interest.status === 200, `interest settle ${interest.status}`);
    const interestRows = await db.query(`SELECT count(*)::int AS n FROM real_fills WHERE user_id = $1 AND kind = 'interest'`, [leaderId]);
    assert(Number(interestRows.rows[0].n) >= 1, "interest did not settle");

    const liqOpen = await call("/api/perps/orders", {
      method: "POST",
      body: JSON.stringify({ symbol: "ETH-PERP", side: "buy", quantity: "0.001", leverage: 2 }),
    }, auth(leader.token));
    assert(liqOpen.status === 200, `liq open ${JSON.stringify(liqOpen.data)}`);
    await db.query(
      `UPDATE real_positions SET entry_px = entry_px * 8 WHERE user_id = $1 AND symbol = 'ETH-PERP' AND status = 'open'`,
      [leaderId],
    );
    const liq = await call("/api/admin/live-settle", { method: "POST", body: JSON.stringify({ totp: totp(FOUNDER.secret) }) }, auth(founder));
    assert(liq.status === 200, `liq settle ${liq.status}`);
    const liquidated = await db.query(
      `SELECT status FROM real_positions WHERE user_id = $1 AND symbol = 'ETH-PERP' ORDER BY id DESC LIMIT 1`,
      [leaderId],
    );
    assert(liquidated.rows[0]?.status === "liquidated", `not liquidated ${JSON.stringify(liquidated.rows)}`);
    const liqFill = await db.query(`SELECT count(*)::int AS n FROM real_fills WHERE user_id = $1 AND kind = 'liquidation'`, [leaderId]);
    assert(Number(liqFill.rows[0].n) >= 1, "liquidation fill missing");

    const named = await call("/api/copy/lead", {
      method: "POST",
      body: JSON.stringify({ displayName: "Desk Lead", optedIn: true }),
    }, auth(leader.token));
    assert(named.status === 200 && named.data.optedIn === true, `opt in ${JSON.stringify(named.data)}`);
    assert(Array.isArray((named.data.stats as { curve: unknown }).curve), "stats missing");
    const listed = await call("/api/copy", {}, auth(follower.token));
    const leaders = listed.data.leaders as { displayName: string; stats: { curve: string[]; closes: number } }[];
    assert(leaders.some((item) => item.displayName === "Desk Lead"), `leaders ${JSON.stringify(leaders)}`);
    assert(leaders.every((item) => item.stats.closes === 0 || item.stats.curve.length === item.stats.closes), "fabricated leader curve");
    assert(!JSON.stringify(leaders).includes("金衡"), "fictional leader leaked into real copy");

    await call("/api/wallets/transfer", {
      method: "POST",
      body: JSON.stringify({ from: "spot", to: "derivatives", amount: "80.00" }),
    }, auth(follower.token));
    const followed = await call("/api/copy/follow", {
      method: "POST",
      body: JSON.stringify({ leaderId: String(leaderId), allocation: "40.00", ratioBps: 10000, maxLoss: "30.00" }),
    }, auth(follower.token));
    assert(followed.status === 200, `follow ${JSON.stringify(followed.data).slice(0, 300)}`);
    const copied = await call("/api/perps/orders", {
      method: "POST",
      body: JSON.stringify({ symbol: "XAU-PERP", side: "buy", quantity: "0.100", leverage: 2 }),
    }, auth(leader.token));
    assert(copied.status === 200, `leader add ${JSON.stringify(copied.data)}`);
    const followerPos = await db.query(
      `SELECT count(*)::int AS n FROM real_positions WHERE user_id = $1 AND copy_follow_id IS NOT NULL AND status = 'open'`,
      [followerId],
    );
    assert(Number(followerPos.rows[0].n) >= 1, "follower did not receive a copied position");

    await setSwitch("perp", false);
    const blocked = await call("/api/perps/orders", {
      method: "POST",
      body: JSON.stringify({ symbol: "XAU-PERP", side: "buy", quantity: "0.100", leverage: 2 }),
    }, auth(leader.token));
    assert(blocked.status === 403 && blocked.data.error === "LIVE_OFF", `kill ${JSON.stringify(blocked.data)}`);
    const still = await call("/api/perps", {}, auth(leader.token));
    assert(still.data.reduceOnly === true, "kill switch did not become reduce-only");
    const closed = await call("/api/perps/close-all", { method: "POST", body: "{}" }, auth(leader.token));
    assert(closed.status === 200, `close all ${JSON.stringify(closed.data)}`);
    const followerClose = await call("/api/copy", {}, auth(follower.token));
    const followId = (followerClose.data.follows as { id: string }[])[0]?.id;
    if (followId) {
      const stopped = await call(`/api/copy/follows/${followId}`, { method: "POST", body: JSON.stringify({ action: "stop" }) }, auth(follower.token));
      assert(stopped.status === 200, `stop follow ${JSON.stringify(stopped.data).slice(0, 200)}`);
    }
    await call("/api/margin/close-all", { method: "POST", body: "{}" }, auth(leader.token));

    const modeAllow = await call("/api/admin/modes", {
      method: "POST",
      body: JSON.stringify({ mode: "perp", country: "SG", access: "allow" }),
    }, auth(founder));
    assert(modeAllow.status === 200, `mode allow ${modeAllow.status} ${JSON.stringify(modeAllow.data)}`);
    perpAllowed = true;
    await call("/api/paper", { method: "POST", body: JSON.stringify({ action: "enable" }) }, auth(leader.token));
    paperOn = true;
    const realBefore = await db.query(
      `SELECT COALESCE(SUM(b.amount),0)::text AS n FROM accounts a JOIN balances b ON b.account_id = a.id
       WHERE a.customer_id = $1 AND a.asset = 'USD' AND a.bucket = 'available'`,
      [leaderId],
    );
    const paperOrder = await call("/api/perps/orders", {
      method: "POST",
      body: JSON.stringify({ symbol: "XAU-PERP", side: "buy", quantity: "0.100", leverage: 2 }),
    }, auth(leader.token));
    assert(paperOrder.status === 200, `paper perp ${JSON.stringify(paperOrder.data)}`);
    const realAfter = await db.query(
      `SELECT COALESCE(SUM(b.amount),0)::text AS n FROM accounts a JOIN balances b ON b.account_id = a.id
       WHERE a.customer_id = $1 AND a.asset = 'USD' AND a.bucket = 'available'`,
      [leaderId],
    );
    assert(realBefore.rows[0].n === realAfter.rows[0].n, "paper perp moved real USD");
    const paperPos = await db.query(`SELECT id::text FROM paper_perps WHERE user_id = $1 AND status = 'open' ORDER BY id DESC LIMIT 1`, [leaderId]);
    if (paperPos.rowCount) {
      await call(`/api/perps/${paperPos.rows[0].id}/close`, { method: "POST", body: "{}" }, auth(leader.token));
    }
    await call("/api/paper", { method: "POST", body: JSON.stringify({ action: "disable" }) }, auth(leader.token));
    paperOn = false;
    const blockedMode = await call("/api/admin/modes", {
      method: "POST",
      body: JSON.stringify({ mode: "perp", country: "SG", access: "block" }),
    }, auth(founder));
    assert(blockedMode.status === 200, `mode block ${blockedMode.status}`);
    perpAllowed = false;

    const exposure = await call("/api/admin/live-exposure", {}, auth(founder));
    assert(exposure.status === 200 && typeof exposure.data.pnlOwedUusd === "string", `exposure ${JSON.stringify(exposure.data).slice(0, 300)}`);
    const invariants = await call("/api/admin/invariants", {}, auth(founder));
    assert(invariants.status === 200 && invariants.data.ok === true, `invariants ${JSON.stringify(invariants.data)}`);
    console.log("live products ok");
  } finally {
    if (paperOn && leaderToken) {
      await call("/api/paper", { method: "POST", body: JSON.stringify({ action: "disable" }) }, auth(leaderToken)).catch((err) => console.error(err));
    }
    if (perpAllowed) {
      await call("/api/admin/modes", {
        method: "POST",
        body: JSON.stringify({ mode: "perp", country: "SG", access: "block" }),
      }, auth(founder)).catch((err) => console.error(err));
    }
    await setSwitch("margin", false).catch((err) => console.error(err));
    await setSwitch("perp", false).catch((err) => console.error(err));
    await setSwitch("copy", false).catch((err) => console.error(err));
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
