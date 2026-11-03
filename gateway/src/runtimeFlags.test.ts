import assert from "node:assert/strict";
import { liveServicesEnabled } from "./runtimeFlags.js";

assert.equal(liveServicesEnabled(undefined), false);
assert.equal(liveServicesEnabled(""), false);
assert.equal(liveServicesEnabled("true"), false);
assert.equal(liveServicesEnabled("0"), false);
assert.equal(liveServicesEnabled("1"), true);

console.log("runtime flags ok");
