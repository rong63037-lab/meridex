import { writeFileSync } from "node:fs";
import { bundledDict, bundledReasons } from "../lib/i18n";
import { deskBundles } from "../lib/desk-copy";
import { accountBundles } from "../lib/account-copy";
import { fundsBundles } from "../lib/funds-copy";
import { conciergeBundles } from "../lib/concierge-copy";

const langs = ["zh", "en", "ms"] as const;
const out: Record<string, string> = {};

for (const lang of langs) {
  for (const [key, value] of Object.entries(bundledDict[lang])) out[`${lang}.${key}`] = value;
  for (const [key, value] of Object.entries(bundledReasons[lang])) out[`reason.${lang}.${key}`] = value;
  for (const [key, value] of Object.entries(deskBundles[lang])) out[`desk.${lang}.${key}`] = value;
  for (const [key, value] of Object.entries(accountBundles[lang])) out[`account.${lang}.${key}`] = value;
  for (const [key, value] of Object.entries(fundsBundles[lang])) out[`funds.${lang}.${key}`] = value;
  for (const [key, value] of Object.entries(conciergeBundles[lang])) out[`concierge.${lang}.${key}`] = value;
}

const target = new URL("../../gateway/src/customer-strings.json", import.meta.url);
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
console.log(`strings=${Object.keys(out).length}`);
