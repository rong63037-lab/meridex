import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const prod = readFileSync(new URL("../docs/PRODUCTION.md", import.meta.url), "utf8");
const gates = readFileSync(new URL("../docs/LAUNCH_GATES.md", import.meta.url), "utf8");
const check = readFileSync(new URL("../scripts/prelaunch-check.ts", import.meta.url), "utf8");
const reset = readFileSync(new URL("../scripts/prelaunch-reset.ts", import.meta.url), "utf8");
const checkSh = readFileSync(new URL("../scripts/prelaunch-check", import.meta.url), "utf8");
const resetSh = readFileSync(new URL("../scripts/prelaunch-reset", import.meta.url), "utf8");

for (const phrase of ["Custody", "Deposit detection", "Bank rails", "KYC", "Licensing", "rollback", "Singapore"]) {
  assert.ok(prod.toLowerCase().includes(phrase.toLowerCase()), `PRODUCTION.md missing ${phrase}`);
}
assert.match(prod, /has been deployed/);
assert.match(prod, /no domain has been registered/);
assert.match(prod, /MERIDEX_BACKUP_OFFSITE/);
assert.match(prod, /ADMIN_IP_ALLOWLIST/);

for (const phrase of ["MAS", "KYC", "privacy", "Incident", "US_RETAIL_BLOCK", "SANDBOX_MOCK_GEO", "simulated"]) {
  assert.ok(gates.includes(phrase), `LAUNCH_GATES.md missing ${phrase}`);
}
assert.match(gates, /docs\/jurisdiction-policy-v0\.md/);
assert.match(gates, /docs\/critical-systems\.md/);
assert.match(gates, /scripts\/prelaunch-check/);

assert.match(check, /db_published_passwords/);
assert.match(check, /owner_credentials_rotated/);
assert.match(check, /cookie_secure/);
assert.match(check, /backup_restore_tested/);
assert.match(check, /address_pool_verified/);
assert.match(check, /params_reviewed/);
assert.match(check, /feeds_healthy/);
assert.match(check, /PRELAUNCH_REPORT\.md/);
assert.match(reset, /dry-run/);
assert.match(reset, /--confirm/);
assert.match(reset, /verifyTotp/);
assert.match(reset, /backup-db\.sh/);
assert.match(reset, /content_overrides/);
assert.match(reset, /address_pool/);
assert.match(checkSh, /prelaunch-check\.ts/);
assert.match(resetSh, /prelaunch-reset\.ts/);

assert.doesNotMatch(reset, /Meridex[A-Za-z]+2026!/);
assert.doesNotMatch(reset, /MERIDEX2[A-Z0-9]{8,}/);

console.log("prelaunch static docs and scripts ok");
