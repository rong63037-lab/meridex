import { bech32Ok, demoAddress, explainAddress, PAIRS } from "./addresses.js";

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

for (const pair of PAIRS) {
  for (let n = 1; n <= 3; n += 1) {
    const address = demoAddress(pair.asset, pair.network, n);
    const reason = explainAddress(pair.asset, pair.network, address);
    assert(reason === null, `${pair.asset} ${pair.network} ${address} ${reason}`);
  }
}

const btc = demoAddress("BTC", "Bitcoin", 1);
assert(btc.startsWith("tb1"), `testnet bech32 ${btc}`);
assert(bech32Ok(btc), "generated bech32 rejected");
assert(explainAddress("BTC", "Bitcoin", `${btc.slice(0, -1)}q`) !== null, "broken bech32 accepted");

const eth = demoAddress("ETH", "Ethereum", 1);
assert(explainAddress("ETH", "Ethereum", eth) === null, "eip55 rejected");
assert(explainAddress("ETH", "Ethereum", eth.toLowerCase()) === null, "lowercase evm rejected");
const flipped = eth.slice(0, -1) + (eth.endsWith("a") || eth.endsWith("A") ? "b" : "A");
assert(explainAddress("ETH", "Ethereum", flipped) !== null, "bad evm checksum accepted");

const tron = demoAddress("USDT", "TRC20", 1);
assert(tron.startsWith("T") && tron.length === 34, `tron shape ${tron}`);
assert(explainAddress("USDT", "TRC20", `${tron.slice(0, -1)}1`) !== null, "bad tron accepted");
assert(explainAddress("USDT", "ERC20", tron) !== null, "tron accepted as erc20");
assert(explainAddress("BTC", "Bitcoin", eth) !== null, "evm accepted as bitcoin");
assert(bech32Ok("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"), "bip173 vector");

console.log("addresses_ok");
