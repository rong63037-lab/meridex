import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

function read(path) {
  return readFileSync(new URL("../" + path, import.meta.url), "utf8");
}

for (const path of ["web/app/perps/page.tsx", "web/app/margin/page.tsx", "web/app/copy/page.tsx"]) {
  const text = read(path);
  assert.match(text, /if \(!paper\) return <Live/, path);
  assert.match(text, /t\.licenceBadge/, path);
  assert.match(text, /t\.paperBanner/, path);
  assert.doesNotMatch(text, /if \(!paper\) return <ComingSoon/, path);
}
const desk = read("web/components/LiveDesk.tsx");
const copy = read("web/components/LiveCopy.tsx");
assert.match(desk, /ComingSoon/);
assert.match(desk, /t\.liveNotice/);
assert.doesNotMatch(desk, /licenceBadge/);
assert.match(copy, /ComingSoon/);
assert.match(copy, /t\.liveNotice/);

const shell = read("web/components/Shell.tsx");
assert.match(shell, /mode\.simulated && paper/);
assert.doesNotMatch(shell, /mode\.simulated \? <em>/);

const zh = read("web/lib/i18n.tsx");
const ms = read("web/lib/locale-ms.ts");
for (const key of ["gatedSoon", "gatedBody", "gatedCta", "qtyWithUnit", "unitGram", "unitKg", "unitOz", "liveNotice", "liveReduce"]) {
  assert.match(zh, new RegExp(`${key}:`), key);
  assert.match(ms, new RegExp(`${key}:`), `ms ${key}`);
}
assert.match(zh, /即将开放/);
assert.match(zh, /Coming soon/);
assert.match(ms, /Akan dibuka/);
assert.doesNotMatch(zh, /qty: "数量（克）"/);
assert.doesNotMatch(zh, /qty: "Quantity \(grams\)"/);

const catalog = read("gateway/src/customer-strings.json");
assert.match(catalog, /"zh\.gatedSoon": "即将开放"/);
assert.match(catalog, /"en\.gatedSoon": "Coming soon"/);
assert.match(catalog, /"ms\.gatedSoon": "Akan dibuka"/);
assert.match(catalog, /"zh\.qtyWithUnit"/);
assert.match(catalog, /"zh\.liveNotice": "内部流动性，尚未接入外部做市商"/);
assert.match(catalog, /"en\.liveNotice": "Internal liquidity, no external market maker yet"/);
assert.doesNotMatch(catalog, /"zh\.qty": "数量（克）"/);

console.log("sim mode ui ok");
