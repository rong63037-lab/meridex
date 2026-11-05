import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pctLeverage, pctSpot, quoteLeverage, quoteSpot } from "../web/lib/simple-math.ts";

const buy = quoteSpot({
  side: "buy",
  mode: "usd",
  amount: "100",
  price: 50,
  usdAvailable: 250,
  baseAvailable: 0,
  qtyDecimals: 3,
  unit: "g",
});
assert.equal(buy.ok, true);
assert.equal(buy.quantity, "2");
assert.equal(buy.pay, "$100.00");
assert.equal(buy.receive, "2 g");
assert.equal(buy.fee, "$0.10");

const short = quoteSpot({
  side: "buy",
  mode: "usd",
  amount: "100",
  price: 50,
  usdAvailable: 40,
  baseAvailable: 1,
  qtyDecimals: 3,
  unit: "g",
});
assert.equal(short.ok, false);
assert.equal(short.reason, "funds");

const sell = quoteSpot({
  side: "sell",
  mode: "qty",
  amount: "0.001",
  price: 65000,
  usdAvailable: 0,
  baseAvailable: 0.01,
  qtyDecimals: 8,
  unit: "BTC",
});
assert.equal(sell.ok, true);
assert.equal(sell.receive, "$65.00");
assert.match(sell.pay, /BTC$/);

assert.equal(pctSpot({
  side: "buy", mode: "usd", pct: 0.5, price: 10, usdAvailable: 80, baseAvailable: 0, qtyDecimals: 3,
}), "40.00");

const lev = quoteLeverage({
  side: "buy",
  mode: "usd",
  amount: "20",
  price: 100,
  leverage: 2,
  freeUsd: 50,
  qtyDecimals: 4,
  unit: "g",
});
assert.equal(lev.ok, true);
assert.equal(lev.quantity, "0.4");
assert.ok(Math.abs(lev.marginUsd - 20) < 0.001);
assert.ok(lev.liq != null && lev.liq < 100);

const one = quoteLeverage({
  side: "sell",
  mode: "qty",
  amount: "1",
  price: 10,
  leverage: 1,
  freeUsd: 100,
  qtyDecimals: 2,
  unit: "ETH",
});
assert.equal(one.ok, true);
assert.ok(Math.abs(one.marginUsd - 10) < 0.001);
assert.ok(one.liq != null && one.liq > 10);

assert.equal(pctLeverage({ mode: "usd", pct: 0.25, price: 10, leverage: 2, freeUsd: 40, qtyDecimals: 2 }), "10.00");

const root = new URL("../", import.meta.url);
const terminal = readFileSync(new URL("web/app/terminal/page.tsx", root), "utf8");
const ticket = readFileSync(new URL("web/components/MarketBits.tsx", root), "utf8");
const live = readFileSync(new URL("web/components/LiveDesk.tsx", root), "utf8");
const chart = readFileSync(new URL("web/components/CandleChart.tsx", root), "utf8");
assert.match(terminal, /limit=300/);
assert.match(terminal, /setInterval\(pull, 30_000\)/);
assert.match(ticket, /SimpleOrder/);
assert.match(live, /meridex\.liveAdvanced/);
assert.match(live, /SimpleOrder/);
assert.match(chart, /series\.update|candle\.update/);
assert.match(chart, /requestAnimationFrame/);

console.log("simple-math ok");
