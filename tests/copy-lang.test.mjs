import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(new URL("../" + path, import.meta.url), "utf8");
}

const help = read("web/app/help/page.tsx");
if (help.includes("Only XAU/USD can be ordered")) {
  throw new Error("help FAQ still says only XAU/USD can be ordered");
}
if (help.includes("交易费是 0") || help.includes("Trading fees are zero")) {
  throw new Error("help FAQ still says trading fees are zero");
}
if (!help.includes("Cari")) throw new Error("help search placeholder has no Malay");

for (const [path, marker] of [
  ["web/app/rewards/page.tsx", "Jemputan dan yuran"],
  ["web/app/support/page.tsx", "Pusat bantuan"],
  ["web/app/inbox/page.tsx", "Pemberitahuan"],
  ["web/app/developers/page.tsx", "API MERIDEX"],
]) {
  const text = read(path);
  if (!text.includes(marker)) throw new Error(`${path} missing Malay marker ${marker}`);
  if (!text.includes("tri(")) throw new Error(`${path} does not use tri()`);
}

const ops = read("web-admin/app/ops/page.tsx");
if (!ops.includes("Operasi")) throw new Error("ops page has no Malay heading");
if (!read("gateway/src/platform.ts").includes("title_ms")) throw new Error("help seed has no Malay title");
if (!read("web/app/help/page.tsx").includes("title_ms")) throw new Error("help page ignores Malay articles");
if (ops.includes("instruments ?? []).slice(0, 6)")) {
  throw new Error("ops listings still hide every instrument after the sixth");
}
if (ops.includes("people.slice(0, 8)")) {
  throw new Error("ops customer table still hides rows after the eighth");
}

const compliance = read("web-admin/app/compliance/page.tsx");
if (!compliance.includes("haltSymbol")) throw new Error("halt control does not name a symbol");
if (compliance.includes("poolAudit.slice(0, 8)")) {
  throw new Error("address-pool audit on the compliance page is still truncated");
}

const halt = read("gateway/src/server.ts");
if (!halt.includes('(body.symbol || "XAU/USD").toUpperCase()')) {
  throw new Error("halt/resume does not normalise the symbol");
}
if (!read("gateway/src/trading.ts").includes('LedgerError("TICK")')) {
  throw new Error("off-tick orders still collapse into VALIDATION");
}
if (!read("web/app/globals.css").includes("max-width: min(1180px, 100%)")) {
  throw new Error("sections can grow wider than the viewport");
}
const tour = read("web/components/Tour.tsx");
if (/if \(path !== step\.href\) router\.push\(step\.href\)/.test(tour.split("function show")[0])) {
  throw new Error("the tour still forces the route on every page change");
}

console.log("copy and listing guards ok");
