import assert from "node:assert/strict";
import { looksLike, parsePaste } from "../web-pool/lib/paste.ts";
import { poolCopy } from "../web-pool/lib/copy.ts";

assert.equal(looksLike("tb1qabcdefghijklmnopqrstuvwxyz012345"), "btc");
assert.equal(looksLike("0x" + "ab".repeat(20)), "evm");
assert.equal(looksLike("T" + "A".repeat(33)), "tron");
assert.equal(looksLike("hello"), "unknown");

const evm = "0x" + "cd".repeat(20);
const mixed = parsePaste(`\n${evm}\ntb1qexampleaddress000000000000000\nnope\n`, "auto");
assert.equal(mixed.length, 3);
assert.equal(mixed[0].clientError, "evm");
assert.equal(mixed[1].asset, "BTC");
assert.equal(mixed[1].clientError, null);
assert.equal(mixed[2].clientError, "unknown");

const picked = parsePaste(`${evm}\nT${"A".repeat(33)}`, "eth");
assert.equal(picked[0].asset, "ETH");
assert.equal(picked[0].network, "Ethereum");
assert.equal(picked[0].clientError, null);
assert.equal(picked[1].clientError, "mismatch");

const tron = parsePaste(`T${"A".repeat(33)}`, "usdt-trc20");
assert.equal(tron[0].asset, "USDT");
assert.equal(tron[0].network, "TRC20");

for (const lang of ["zh", "en", "ms"] as const) {
  assert.ok(poolCopy[lang].add.length > 0);
  assert.ok(poolCopy[lang].help.length > 20);
  assert.equal(poolCopy.zh.add, "添加地址");
}
assert.match(poolCopy.en.add, /Add addresses/);
assert.match(poolCopy.ms.add, /Tambah/);

console.log("pool paste ok");
