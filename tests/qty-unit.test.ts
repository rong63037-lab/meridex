import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { liveQty, parseLivePrice, parseLiveQty, parseUsdMicro } from "../web/lib/liveQty.ts";
import { fillTemplate, formatQtyWithUnit, formatScaled, qtySpec, unitLabel } from "../web/lib/qty.ts";

type Row = {
  symbol: string;
  base: string;
  category: string;
  minQty: number;
  qtyScale: number;
  qtyDecimals: number;
  refPrice: number;
  priceScale: number;
};

const catalog = JSON.parse(readFileSync(new URL("../engine/instruments.json", import.meta.url), "utf8")) as Row[];
const words = { gram: "克", kilogram: "千克", ounce: "盎司" };

for (const row of catalog) {
  const spec = qtySpec(row.symbol);
  assert.equal(spec.scale, row.qtyScale, `${row.symbol} scale`);
  assert.equal(spec.decimals, row.qtyDecimals, `${row.symbol} decimals`);
  const minShown = Number(spec.min);
  const catalogMin = row.minQty / row.qtyScale;
  assert.ok(Math.abs(minShown - catalogMin) < 1e-9, `${row.symbol} min ${spec.min} vs ${catalogMin}`);
  const qty = Number(spec.defaultQty);
  assert.ok(qty + 1e-12 >= catalogMin, `${row.symbol} default ${spec.defaultQty} is below the minimum`);
  const px = row.refPrice / row.priceScale;
  const notional = qty * px;
  const minNotional = catalogMin * px;
  if (minNotional < 400) {
    assert.ok(notional < 400, `${row.symbol} default ${spec.defaultQty} is about $${notional.toFixed(0)}`);
  } else {
    assert.ok(Math.abs(qty - catalogMin) < 1e-9, `${row.symbol} one unit is already large, so the default should be the minimum`);
  }
  if (row.category === "metal" && row.base === "XAUKG") assert.equal(spec.unitKey, "kilogram");
  else if (row.category === "metal" && row.base === "XAUOZ") assert.equal(spec.unitKey, "ounce");
  else if (row.category === "metal") assert.equal(spec.unitKey, "gram");
  else {
    assert.equal(spec.unitKey, "ticker", row.symbol);
    assert.equal(spec.ticker, row.base, row.symbol);
    assert.notEqual(unitLabel(spec, words), "克", row.symbol);
  }
}

assert.equal(unitLabel(qtySpec("XAU-PERP"), words), "克");
assert.equal(unitLabel(qtySpec("XAG/USD"), words), "克");
assert.equal(unitLabel(qtySpec("BTC-PERP"), words), "BTC");
assert.equal(unitLabel(qtySpec("ETH-PERP"), words), "ETH");
assert.equal(qtySpec("BTC-PERP").defaultQty, "0.001");
assert.notEqual(qtySpec("BTC/USD").defaultQty, "0.100");
assert.equal(fillTemplate("数量（{unit}）", { unit: unitLabel(qtySpec("BTC-PERP"), words) }), "数量（BTC）");
assert.equal(fillTemplate("Quantity ({unit})", { unit: unitLabel(qtySpec("ETH-PERP"), { gram: "g", kilogram: "kg", ounce: "oz" }) }), "Quantity (ETH)");
assert.equal(formatScaled("100000", 100_000_000, 8), "0.00100000");
assert.equal(formatScaled("100", 1000, 3), "0.100");
assert.equal(formatQtyWithUnit("BTC/USD", "100000", words), "0.001 BTC");
assert.equal(formatQtyWithUnit("XAU/USD", "100", words), "0.1 克");
assert.equal(formatQtyWithUnit("ETH-PERP", "1000000", words), "0.01 ETH");

const history = readFileSync(new URL("../web/app/funds/history/page.tsx", import.meta.url), "utf8");
assert.match(history, /formatQtyWithUnit/);
assert.doesNotMatch(history, /mgToGrams/);
const page = readFileSync(new URL("../web/app/perps/page.tsx", import.meta.url), "utf8");
const shell = readFileSync(new URL("../web/components/Shell.tsx", import.meta.url), "utf8");
const ticket = readFileSync(new URL("../web/components/MarketBits.tsx", import.meta.url), "utf8");
assert.match(page, /qtyWithUnit/);
assert.match(page, /ComingSoon/);
assert.doesNotMatch(page, /useState\("0\.100"\)/);
assert.match(shell, /mode\.simulated && paper/);
assert.match(ticket, /qtyWithUnit/);
assert.doesNotMatch(ticket, /book\.base \?\? "g"/);

const xau = liveQty("XAU/USD");
const btc = liveQty("BTC-PERP");
const eth = liveQty("ETH/USD");
assert.equal(xau.minText, "0.100");
assert.equal(xau.stepText, "0.001");
assert.equal(xau.tickText, "$0.01");
assert.equal(btc.stepText, "0.00000001");
assert.equal(btc.tickText, "$1.00");
assert.equal(eth.minRaw, 100_000n);
assert.equal(eth.tickText, "$0.10");
assert.equal(parseLiveQty("0.099", xau).ok, false);
assert.equal(parseLiveQty("0.1005", xau).ok, false);
assert.deepEqual(parseLiveQty("0.100", xau), { ok: true, raw: 100n });
assert.deepEqual(parseLiveQty("0.0001", btc), { ok: true, raw: 10_000n });
assert.equal(parseLiveQty("0.00010001", btc).ok, true);
assert.equal(parseLivePrice("100.01", btc).ok, false);
assert.deepEqual(parseLivePrice("100.00", btc), { ok: true, cents: 10_000n });
assert.equal(parseLivePrice("3500.10", eth).ok, true);
assert.equal(parseLivePrice("3500.11", eth).ok, false);
assert.equal(parseUsdMicro("0").ok, false);
assert.equal(parseUsdMicro("1.0000001").ok, false);
assert.deepEqual(parseUsdMicro("20.5"), { ok: true, micro: 20_500_000n });

console.log("qty unit ok");
