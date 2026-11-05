import { demoAddress } from "./addresses.js";
import { createPool, migrate } from "./db.js";
import { previewAddresses } from "./pool.js";

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const pool = createPool(process.env.DATABASE_URL ?? "postgres://meridex:<redacted>@127.0.0.1:5432/meridex");
await migrate(pool);

const known = await pool.query<{ address: string; asset: string; network: string }>(
  `SELECT address, asset, network FROM address_pool LIMIT 1`,
);
assert(known.rowCount, "pool has no address to compare");
const fresh = demoAddress("BTC", "Bitcoin", 880);
const result = await previewAddresses(pool, [
  { line: 2, asset: "BTC", network: "Bitcoin", address: "not-an-address" },
  { line: 3, asset: known.rows[0].asset, network: known.rows[0].network, address: known.rows[0].address },
  { line: 4, asset: "BTC", network: "Bitcoin", address: fresh },
  { line: 5, asset: "BTC", network: "Bitcoin", address: fresh },
]);

assert(result.lines.length === 4, "line count");
assert(result.lines[0].ok === false && result.lines[0].reason === "bad bitcoin checksum", result.lines[0].reason ?? "");
assert(result.lines[1].ok === false && result.lines[1].reason === "duplicate", "known address");
assert(result.lines[2].ok === true && result.lines[2].reason === null, "fresh address");
assert(result.lines[3].reason === "duplicate", "repeat in the same paste");
assert(result.ready === 1, `ready ${result.ready}`);

const still = await pool.query(`SELECT 1 FROM address_pool WHERE lower(address) = lower($1)`, [fresh]);
assert(still.rowCount === 0, "preview wrote a row");
await pool.end();
console.log("pool preview ok");
