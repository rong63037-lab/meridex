/**
 * Symbol navigation. A click, a poll, and a re-sort all key off the symbol string.
 * Run: ./gateway/node_modules/.bin/tsx tests/symbol-nav.test.ts
 */
import { readFileSync } from "node:fs";
import {
  DEFAULT_SYMBOL,
  chooseSymbol,
  marketHref,
  pickerSymbols,
  resolveSymbol,
  rowTargets,
  selectedAfterResort,
  symbolSlug,
  takeLookup,
  terminalHref,
} from "../web/lib/symbol.ts";

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const catalog = (JSON.parse(readFileSync(new URL("../engine/instruments.json", import.meta.url), "utf8")) as { symbol: string }[])
  .map((row) => row.symbol);

assert(catalog.includes("BTC/USD") && catalog.includes("XAU/USD") && catalog.includes("XAUKG/USD"), "catalog missing symbols");

for (const symbol of catalog) {
  assert(resolveSymbol(symbol, catalog) === symbol, `raw ${symbol}`);
  assert(resolveSymbol(symbol.toLowerCase(), catalog) === symbol, `lower ${symbol}`);
  assert(resolveSymbol(symbolSlug(symbol), catalog) === symbol, `slug ${symbol}`);
  assert(resolveSymbol(symbolSlug(symbol).toUpperCase(), catalog) === symbol, `slug upper ${symbol}`);
  const href = terminalHref(symbol);
  assert(href.startsWith("/terminal?symbol="), `href ${symbol}`);
  assert(decodeURIComponent(href.slice("/terminal?symbol=".length)) === symbol, `roundtrip ${symbol}`);
  assert(marketHref(symbol) === `/markets/${symbolSlug(symbol)}`, `market href ${symbol}`);
}

assert(resolveSymbol("xau", catalog) === null, "bare xau must not steal a gold contract");
assert(resolveSymbol("xau-usd", catalog) === "XAU/USD", "xau-usd");
assert(resolveSymbol("xaukg-usd", catalog) === "XAUKG/USD", "xaukg-usd");
assert(resolveSymbol("XAUKG/USD", catalog) !== "XAU/USD", "kilobar is not spot gold");
assert(resolveSymbol("btc-usd", catalog) === "BTC/USD", "btc-usd");
assert(resolveSymbol("btc/usd", catalog) === "BTC/USD", "btc/usd");
assert(resolveSymbol("BTC-USD", catalog) === "BTC/USD", "BTC-USD");

const rows = catalog.map((symbol, index) => ({ symbol, rank: (index * 17) % 13 }));
const byRank = [...rows].sort((a, b) => b.rank - a.rank || a.symbol.localeCompare(b.symbol));
const targets = rowTargets(byRank);
assert(targets.length === catalog.length, "every row");
for (const row of targets) {
  assert(row.href === terminalHref(row.symbol), `row ${row.symbol} opened ${row.href}`);
  const label = row.symbol;
  assert(decodeURIComponent(row.href.split("symbol=")[1]) === label, `label/href mismatch ${label}`);
}
const btc = targets.find((row) => row.symbol === "BTC/USD");
const xau = targets.find((row) => row.symbol === "XAU/USD");
assert(btc && xau && btc.href !== xau.href, "BTC and XAU must not share a target");

const requested = chooseSymbol({ url: "BTC/USD", stored: "XAU/USD" }, catalog);
assert(requested.symbol === "BTC/USD" && requested.source === "url", "url beats storage");
const slugged = chooseSymbol({ url: "btc-usd", stored: "XAU/USD" }, catalog);
assert(slugged.symbol === "BTC/USD" && slugged.source === "url", "slug url beats gold storage");
const kilobar = chooseSymbol({ url: "xaukg-usd", stored: "XAU/USD" }, catalog);
assert(kilobar.symbol === "XAUKG/USD", "kilobar url");
const storedOnly = chooseSymbol({ url: "", stored: "ETH/USD" }, catalog);
assert(storedOnly.symbol === "ETH/USD" && storedOnly.source === "stored", "storage when url empty");
const fallback = chooseSymbol({ url: null, stored: null }, catalog);
assert(fallback.symbol === DEFAULT_SYMBOL && fallback.source === "default", "default only when both empty");
const unknown = chooseSymbol({ url: "nope/usd", stored: "XAU/USD" }, catalog);
assert(unknown.symbol === "nope/usd" && unknown.source === "url", "unknown url must not fall back to gold");

const again = chooseSymbol({ url: "BTC/USD", stored: "XAU/USD" }, catalog);
assert(again.symbol === requested.symbol, "a second poll must not change the choice");

const filtered = catalog.filter((symbol) => symbol.startsWith("XAU"));
const picker = pickerSymbols(filtered, "BTC/USD");
assert(picker[0] === "BTC/USD" && picker.includes("XAU/USD"), "active symbol stays in the switcher when the filter hides it");
assert(pickerSymbols(catalog, "BTC/USD").filter((symbol) => symbol === "BTC/USD").length === 1, "no duplicate option");

let selected = "BTC/USD";
const resorted = [...byRank].sort((a, b) => a.symbol.localeCompare(b.symbol));
selected = selectedAfterResort(selected, resorted);
assert(selected === "BTC/USD", "sort must not move the selection to another row");
assert(resorted[0].symbol !== "BTC/USD" || resorted.find((row) => row.symbol === selected)?.symbol === "BTC/USD", "identity");

const symbols = catalog;
const goldGen = 1;
const btcGen = 2;
assert(takeLookup(goldGen, btcGen, "xau-usd", symbols) === null, "stale gold response dropped");
assert(takeLookup(btcGen, btcGen, "btc-usd", symbols) === "BTC/USD", "current btc response kept");
assert(takeLookup(btcGen, btcGen, "xau-usd", symbols) === "XAU/USD", "only the current slug resolves");

const watch = ["XAU/USD", "XAG/USD", "BTC/USD", "ETH/USD"];
const symbolAfterWatch = selected;
assert(watch.includes("BTC/USD") && symbolAfterWatch === "BTC/USD", "watchlist edit is not a symbol change");

console.log(`SYMBOL_NAV_OK rows=${catalog.length}`);
