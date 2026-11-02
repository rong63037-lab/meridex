/**
 * Non-crypto markets stay selectable. The whole pair row opens the symbol,
 * including the price cell, and a missing quote has a retry label.
 * Run: cd gateway && npx tsx ../tests/pair-nav.test.ts
 */
import { readFileSync } from "node:fs";
import { terminalHref } from "../web/lib/symbol.ts";

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const terminal = readFileSync(new URL("../web/app/terminal/page.tsx", import.meta.url), "utf8");
const markets = readFileSync(new URL("../web/app/markets/page.tsx", import.meta.url), "utf8");
const home = readFileSync(new URL("../web/app/page.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../web/app/globals.css", import.meta.url), "utf8");
const zh = readFileSync(new URL("../web/lib/i18n.tsx", import.meta.url), "utf8");
const ms = readFileSync(new URL("../web/lib/locale-ms.ts", import.meta.url), "utf8");
const row = terminal.slice(terminal.indexOf("function Row"));

assert(row.includes('className={`mkt-row ${active ? "on" : ""}`}'), "pair row");
assert(row.includes("onClick={() => onPick(item.symbol)}"), "the row itself selects the symbol");
assert(row.indexOf("onClick={() => onPick(item.symbol)}") < row.indexOf("formatPx"), "the price cell sits inside the clickable row");
assert(row.includes("ev.stopPropagation()"), "the star does not steal the row click");
assert(terminal.includes('data-cat={item}'), "category tabs are addressable");
assert(terminal.includes("t.quoteUnavailable") && terminal.includes("t.quoteRetry"), "missing quote can be retried");
assert(terminal.includes("setChartState(\"error\")"), "a failed candle request is not a blank chart");

assert(markets.includes("onClick={() => router.push(terminalHref(row.symbol))}"), "markets table row opens the terminal");
assert(markets.includes("ev.stopPropagation()"), "starring a market does not navigate");
assert(home.includes("onClick={() => router.push(terminalHref(row.symbol))}"), "home row opens the terminal");

assert(zh.includes('quoteUnavailable: "这个品种的报价暂时不可用。"'), "zh unavailable");
assert(zh.includes('quoteUnavailable: "This quote is unavailable right now."'), "en unavailable");
assert(zh.includes('quoteRetry: "Retry"'), "en retry");
assert(ms.includes('quoteUnavailable: "Sebut harga ini tidak tersedia buat masa ini."'), "ms unavailable");
assert(ms.includes('quoteRetry: "Cuba lagi"'), "ms retry");

assert(css.includes(".mkt-list { overflow: auto;"), "pair list scrolls inside the column");
assert(css.includes(".book-col { grid-area: book; display: flex; flex-direction: column; min-height: 0; gap: 8px; overflow: auto; }"), "book scrolls instead of covering the list");
assert(css.includes("pointer-events: none;"), "toasts do not eat pair clicks");
assert(/minmax\(140px, 26vh\)/.test(css), "laptop layout keeps a markets row on screen");

for (const symbol of ["EUR/USD", "XAU/USD", "XAU/XAG", "BRENT/USD", "GBP/USD"]) {
  const href = terminalHref(symbol);
  assert(decodeURIComponent(href.split("symbol=")[1] ?? "") === symbol, href);
}

console.log("pair-nav ok");
