import { demoAddress } from "./addresses.js";
import { createPool, migrate } from "./db.js";
import { assignNext, importAddresses } from "./pool.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://meridex:<redacted>@127.0.0.1:5432/meridex";

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const pool = createPool(databaseUrl);
await migrate(pool);

const stamp = Date.now();
const made = await pool.query(
  `INSERT INTO users (email, password_hash, totp_secret, role)
   VALUES ($1,'x','<redacted>','customer'), ($2,'x','<redacted>','customer')
   RETURNING id`,
  [`pool-a-${stamp}@meridexexchange.com`, `pool-b-${stamp}@meridexexchange.com`],
);
const userA = Number(made.rows[0].id);
const userB = Number(made.rows[1].id);

const held = await pool.query(
  `SELECT id FROM address_pool WHERE asset = 'BTC' AND network = 'Bitcoin' AND status = 'available'`,
);
const heldIds = held.rows.map((row) => Number(row.id));
await pool.query(`UPDATE address_pool SET status = 'retired' WHERE id = ANY($1::bigint[])`, [heldIds]);
try {
  const empty = await assignNext(pool, userA, "BTC", "Bitcoin");
  assert(empty.status === "preparing", `expected preparing, got ${empty.status} ${empty.address}`);
} finally {
  await pool.query(
    `UPDATE address_pool SET status = 'available', user_id = NULL WHERE id = ANY($1::bigint[]) AND user_id IS NULL`,
    [heldIds],
  );
}

const address = demoAddress("BTC", "Bitcoin", 900 + (stamp % 50));
const owner = await pool.query(`SELECT id FROM users WHERE address_pool_owner = true LIMIT 1`);
assert(owner.rowCount, "owner missing");
await importAddresses(pool, Number(owner.rows[0].id), "127.0.0.1", [{ asset: "BTC", network: "Bitcoin", address }]);
const others = await pool.query(
  `SELECT id FROM address_pool WHERE asset = 'BTC' AND network = 'Bitcoin' AND status = 'available' AND lower(address) <> lower($1)`,
  [address],
);
const otherIds = others.rows.map((row) => Number(row.id));
await pool.query(`UPDATE address_pool SET status = 'retired' WHERE id = ANY($1::bigint[])`, [otherIds]);
try {
  const [left, right] = await Promise.all([
    assignNext(pool, userA, "BTC", "Bitcoin"),
    assignNext(pool, userB, "BTC", "Bitcoin"),
  ]);
  const wins = [left, right].filter((item) => item.status === "ready");
  assert(wins.length === 1, `race winners ${wins.length} ${left.status} ${right.status}`);
  assert(wins[0].address?.toLowerCase() === address.toLowerCase(), `race address ${wins[0].address}`);
  const dup = await pool.query(`SELECT count(*)::int AS n FROM address_pool WHERE lower(address) = lower($1)`, [address]);
  assert(Number(dup.rows[0].n) === 1, "address duplicated");
} finally {
  await pool.query(
    `UPDATE address_pool SET status = 'available', user_id = NULL WHERE id = ANY($1::bigint[]) AND user_id IS NULL`,
    [otherIds],
  );
}

const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(`INSERT INTO pool_audit (action, detail) VALUES ('test-immutable', 'probe')`);
  let blocked = false;
  try {
    await client.query(`UPDATE pool_audit SET detail = 'mutated' WHERE action = 'test-immutable'`);
  } catch (err) {
    blocked = String((err as Error).message).includes("append-only");
  }
  await client.query("ROLLBACK");
  assert(blocked, "pool_audit accepted an update");
} finally {
  client.release();
}

await pool.query(`DELETE FROM address_history WHERE user_id = ANY($1::bigint[])`, [[userA, userB]]);
await pool.query(`DELETE FROM address_pool WHERE user_id = ANY($1::bigint[])`, [[userA, userB]]);
await pool.query(`DELETE FROM users WHERE id = ANY($1::bigint[])`, [[userA, userB]]);
await pool.end();
console.log("pool_db_ok");
