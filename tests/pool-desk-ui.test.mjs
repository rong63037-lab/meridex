import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const page = readFileSync(new URL("../web-pool/app/page.tsx", import.meta.url), "utf8");
const login = readFileSync(new URL("../web-pool/app/login/page.tsx", import.meta.url), "utf8");
const admin = readFileSync(new URL("../web-admin/app/treasury/page.tsx", import.meta.url), "utf8");

assert.match(page, /t\.add/);
assert.match(page, /parsePaste/);
assert.match(page, /\/api\/pool\/treasury\/pool\/preview/);
assert.match(page, /\/api\/pool\/treasury\/pool\/import/);
assert.match(page, /\/api\/pool\/treasury\/pool\/edit/);
assert.match(page, /\/api\/pool\/treasury\/pool\/delete/);
assert.match(page, /status === "assigned"/);
assert.match(page, /status === "available"/);
assert.match(page, /<details/);
assert.match(page, /t\.replace/);
assert.match(page, /t\.remove/);
assert.doesNotMatch(page, /导入批次/);
assert.doesNotMatch(page, /删除未分配/);
assert.match(login, /useLang/);
assert.match(login, /t\.signIn/);
assert.doesNotMatch(admin, /treasury\/pool\/import/);
assert.doesNotMatch(admin, /method: "POST"/);

console.log("pool desk ui ok");
