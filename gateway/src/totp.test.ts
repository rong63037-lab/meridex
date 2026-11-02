import assert from "node:assert/strict";
import { base32Encode, hotp } from "./crypto.js";

const secret = base32Encode(Buffer.from("12345678901234567890"));
assert.equal(secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
assert.equal(hotp(secret, 1n, 8), "94287082");
assert.equal(hotp(secret, 37037036n, 8), "07081804");
assert.equal(hotp(secret, 37037037n, 8), "14050471");
console.log("totp vectors ok");
