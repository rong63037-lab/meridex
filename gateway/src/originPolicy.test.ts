import assert from "node:assert/strict";
import { createOriginPolicy } from "./originPolicy.js";

const allows = createOriginPolicy("https://customer.example,https://staff.example");

assert.equal(allows("http://127.0.0.1:4317"), true);
assert.equal(allows("https://customer.example"), true);
assert.equal(allows("https://staff.example"), true);
assert.equal(allows("https://untrusted.example"), false);
assert.equal(allows("https://customer.example.attacker.invalid"), false);
assert.equal(allows("https://customer.example/path"), false);
assert.equal(allows("null"), false);
assert.equal(allows(undefined), false);
assert.throws(() => createOriginPolicy("https://customer.example/path"), /INVALID_CORS_ORIGIN/);

console.log("origin policy ok");
