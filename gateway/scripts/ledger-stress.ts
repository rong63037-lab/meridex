/**
 * Isolated ledger + matching run. Uses meridex_test and a private engine port
 * so the investor book on 7109 is left alone.
 *
 *   ORDERS=100000 npx tsx scripts/ledger-stress.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { hashPassword } from "../src/crypto.ts";
import { createPool, migrate, withTx, type Db } from "../src/db.ts";
import { EngineClient } from "../src/engineClient.ts";
import { checkInvariants, clearAccountCache, deposit, type CustomerRef } from "../src/ledger.ts";
import { placeOrder } from "../src/trading.ts";

const ORDERS = Number(process.env.ORDERS ?? "100000");
const PORT = process.env.STRESS_ENGINE_PORT ?? "7119";
const DBNAME = process.env.STRESS_DB ?? "meridex_test";
const DATABASE_URL = process.env.STRESS_DATABASE_URL ?? `postgres://meridex:<redacted>@127.0.0.1:5432/${DBNAME}`;
const JOURNAL = process.env.STRESS_JOURNAL ?? "/tmp/meridex-stress-journal.jsonl";
const ENGINE_BIN = process.env.ENGINE_BIN ?? "/workspace/engine/target/debug/meridex-engine";

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function recreateDatabase() {
  const adminUrl = "postgres://meridex:<redacted>@127.0.0.1:5432/postgres";
  const admin = createPool(adminUrl);
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [DBNAME],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${DBNAME}`);
    await admin.query(`CREATE DATABASE ${DBNAME} OWNER meridex`);
    await admin.end();
    return;
  } catch (err) {
    await admin.end().catch(() => undefined);
    console.log(`db recreate via role failed (${(err as Error).message}); trying postgres superuser`);
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "sudo",
      [
        "-u",
        "postgres",
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DBNAME}' AND pid <> pg_backend_pid();`,
        "-c",
        `DROP DATABASE IF EXISTS ${DBNAME};`,
        "-c",
        `CREATE DATABASE ${DBNAME} OWNER meridex;`,
      ],
      { stdio: "inherit" },
    );
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`createdb exit ${code}`))));
  });
}

function startEngine(): ChildProcess {
  rmSync(JOURNAL, { force: true });
  mkdirSync("/tmp", { recursive: true });
  const child = spawn(ENGINE_BIN, ["serve"], {
    env: {
      ...process.env,
      ENGINE_BIND: `127.0.0.1:${PORT}`,
      ENGINE_JOURNAL: JOURNAL,
      ENGINE_REF_PRICE: "13000",
      ENGINE_BAND_BPS: "500",
      ENGINE_HALT_BPS: "200",
      ENGINE_FSYNC_EVERY: "200",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", (buf) => process.stderr.write(buf));
  return child;
}

async function waitHealthy(engine: EngineClient) {
  for (let i = 0; i < 50; i++) {
    try {
      const health = await engine.health();
      if (health.ok !== undefined || health.state_hash) return health;
    } catch {
      /* booting */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("stress engine did not become healthy");
}

async function makeUser(pool: Db, email: string, entityId: string, jurisdiction: string): Promise<CustomerRef> {
  const inserted = await pool.query(
    `INSERT INTO users (email, password_hash, totp_secret, role, entity_id, jurisdiction)
     VALUES ($1,$2,$3,'customer',$4,$5) RETURNING id`,
    [email, hashPassword("<redacted>"), "<redacted>", entityId, jurisdiction],
  );
  const user: CustomerRef = { id: Number(inserted.rows[0].id), entityId, jurisdiction };
  await withTx(pool, async (client) => {
    await deposit(client, user, "USD", 50_000_000n * 1_000_000n);
    await deposit(client, user, "XAU", 100_000_000n);
  });
  return user;
}

async function main() {
  await recreateDatabase();
  clearAccountCache();
  const engineProc = startEngine();
  const pool = createPool(DATABASE_URL);
  const engine = new EngineClient(`http://127.0.0.1:${PORT}`);
  try {
    await waitHealthy(engine);
    await migrate(pool);
    const sg: CustomerRef[] = [];
    for (let i = 0; i < 12; i++) {
      sg.push(await makeUser(pool, `sg${i}@stress.meridex`, "SG-OPCO", "SG"));
    }
    const my = await makeUser(pool, "my@stress.meridex", "MY-ENTITY", "MY");

    const selfAsk = await placeOrder(pool, engine, sg[0], {
      side: "sell",
      orderType: "limit",
      priceCents: 13000n,
      qtyMg: 1000n,
    });
    assert(!selfAsk.rejectReason && selfAsk.status === "open", `self ask ${JSON.stringify(selfAsk)}`);
    const selfTake = await placeOrder(pool, engine, sg[0], {
      side: "buy",
      orderType: "limit",
      priceCents: 13000n,
      qtyMg: 1000n,
    });
    assert(selfTake.rejectReason === "SELF_TRADE", `stp ${JSON.stringify(selfTake)}`);
    const band = await placeOrder(pool, engine, sg[1], {
      side: "buy",
      orderType: "limit",
      priceCents: 20000n,
      qtyMg: 1000n,
    });
    assert(band.rejectReason === "PRICE_BAND", `band ${JSON.stringify(band)}`);
    console.log("stp_reject=SELF_TRADE price_band=PRICE_BAND");

    const started = Date.now();
    const counts: Record<string, number> = {};
    for (let i = 0; i < ORDERS; i++) {
      const user = sg[i % sg.length];
      const side = i % 2 === 0 ? "buy" : "sell";
      const price = 12920n + BigInt((i * 17) % 160);
      const qty = 100n + BigInt((i * 13) % 500);
      const orderType = i % 23 === 0 ? "ioc" : i % 29 === 0 ? "post_only" : "limit";
      try {
        const result = await placeOrder(pool, engine, user, {
          side,
          orderType,
          priceCents: price,
          qtyMg: qty,
        });
        const key = result.rejectReason ?? result.status;
        counts[key] = (counts[key] ?? 0) + 1;
      } catch (err) {
        const key = (err as Error).message || "throw";
        counts[key] = (counts[key] ?? 0) + 1;
      }
      if ((i + 1) % 5000 === 0) {
        const elapsed = Date.now() - started;
        console.log(`progress ${i + 1}/${ORDERS} elapsed_ms=${elapsed} rate=${((i + 1) / (elapsed / 1000)).toFixed(1)}/s`);
      }
    }
    const elapsed = Date.now() - started;

    const book = await engine.book();
    if (book.halted) await engine.command({ type: "resume" });
    let crossPrice = Math.min((book.bids[0]?.price ?? 13000) + 40, book.halt_high - 1);
    let resting = await placeOrder(pool, engine, sg[3], {
      side: "sell",
      orderType: "post_only",
      priceCents: BigInt(crossPrice),
      qtyMg: 500n,
    });
    if (resting.rejectReason) {
      crossPrice = book.halt_high - 1;
      resting = await placeOrder(pool, engine, sg[3], {
        side: "sell",
        orderType: "post_only",
        priceCents: BigInt(crossPrice),
        qtyMg: 500n,
      });
    }
    assert(resting.status === "open", `cross seed ask ${JSON.stringify(resting)}`);
    const cross = await placeOrder(pool, engine, my, {
      side: "buy",
      orderType: "limit",
      priceCents: BigInt(crossPrice),
      qtyMg: 500n,
    });
    assert(!cross.rejectReason && cross.trades.length > 0, `cross-entity buy ${JSON.stringify(cross)}`);
    const crossTrades = await pool.query(
      `SELECT count(*)::int AS n FROM trades WHERE buyer_entity <> seller_entity`,
    );
    assert(Number(crossTrades.rows[0].n) > 0, "no cross-entity trade");

    const checks = await withTx(pool, (client) => checkInvariants(client));
    const failed = checks.filter((c) => !c.ok);
    for (const check of checks) console.log(`${check.ok ? "OK" : "FAIL"} ${check.name} ${check.detail}`);
    assert(failed.length === 0, `invariant failures ${failed.length}`);

    const replay = await engine.replayVerify();
    const live = await engine.health();
    assert(replay.ok && replay.state_hash === live.state_hash, `replay ${JSON.stringify(replay)} live ${live.state_hash}`);

    const trades = await pool.query(`SELECT count(*)::int AS n FROM trades`);
    const negatives = checks.find((c) => c.name === "no_negative_balances");
    console.log(
      `LEDGER orders=${ORDERS} trades=${trades.rows[0].n} cross_entity_trades=${crossTrades.rows[0].n} elapsed_ms=${elapsed} negatives=${negatives?.detail} invariants_failed=0 replay_hash=${replay.state_hash}`,
    );
    console.log(`status_counts=${JSON.stringify(counts)}`);
  } finally {
    await pool.end();
    engineProc.kill("SIGTERM");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
