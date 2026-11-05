/**
 * Browser check for the funds desk, a customer profile, and the wallet fund id.
 * Needs Chrome and puppeteer-core. Not part of `make test`.
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { totp } from "../gateway/src/crypto.ts";

const require = createRequire(new URL("../gateway/package.json", import.meta.url));
const puppeteer = require("/tmp/audit-deps/node_modules/puppeteer-core");
const ADMIN = "http://127.0.0.1:4318";
const WEB = "http://127.0.0.1:4317";
const GW = "http://127.0.0.1:7108";
const founder = ["founder@meridexexchange.com", "<redacted>", "<redacted>"];
const demo = ["client@meridexexchange.com", "<redacted>", "<redacted>"];

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function api(path, token, body) {
  const res = await fetch(GW + path, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "x-mock-country": "SG",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function login(email, password, secret, portal) {
  const path = portal === "staff" ? "/api/admin/auth/login" : "/api/auth/login";
  const res = await api(path, "", { email, password, totp: totp(secret) });
  assert(res.status === 200, `login ${portal} ${res.status} ${JSON.stringify(res.data)}`);
  return res.data.token;
}

async function main() {
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
mkdirSync("/tmp/funds-ui", { recursive: true });
const staff = await login(...founder, "staff");
const customer = await login(...demo, "customer");
const me = await api("/api/me", customer);
const fundId = me.data.fundId;
const reference = `ui35${Date.now()}`;
const claim = await api("/api/wallet/deposit-claims", customer, { asset: "USD", network: "Bank", amount: "9.00", reference });
assert(claim.status === 200, `claim ${claim.status} ${JSON.stringify(claim.data)}`);

const page = await browser.newPage();
async function overflow() {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth - doc.clientWidth;
  });
}
async function openStaff(path, lang, width) {
  await page.setViewport({ width, height: width === 390 ? 844 : 900 });
  await page.goto(ADMIN + "/login", { waitUntil: "domcontentloaded" });
  await page.evaluate((token, language) => {
    localStorage.setItem("meridex.staff.token", token);
    localStorage.setItem("meridex.lang", language);
  }, staff, lang);
  await page.goto(ADMIN + path, { waitUntil: "networkidle0", timeout: 20000 });
  await new Promise((r) => setTimeout(r, 400));
}

await openStaff("/", "zh", 1440);
let text = await page.evaluate(() => document.body.innerText);
assert(text.includes("待入金") && text.includes("待出金"), `home todo ${text.slice(0, 200)}`);
await page.click("a[href='/funds?tab=deposits']");
await page.waitForFunction(() => location.pathname === "/funds");
await page.goto(`${ADMIN}/funds?tab=deposits&q=${encodeURIComponent(reference)}`, { waitUntil: "networkidle0", timeout: 20000 });
await new Promise((r) => setTimeout(r, 500));
text = await page.evaluate(() => document.body.innerText);
assert(text.includes("入金") && text.includes("出金") && text.includes(reference), `funds zh ${text.slice(0, 400)}`);
assert((await overflow()) <= 24, `overflow 1440 ${await overflow()}`);

const buttons = await page.$$("tbody button");
assert(buttons.length >= 1, "no credit button");
await buttons[0].click();
await page.waitForSelector(".sheet");
await page.evaluate((code) => {
  const input = document.querySelector(".sheet input[inputmode='numeric']");
  const proto = Object.getPrototypeOf(input);
  Object.getOwnPropertyDescriptor(proto, "value").set.call(input, code);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}, totp(founder[2]));
await page.click(".sheet .filters button");
await page.waitForFunction(() => document.body.innerText.includes("已入账"), { timeout: 8000 });
text = await page.evaluate(() => document.body.innerText);
assert(text.includes(fundId), `success missing fund id ${text.slice(0, 240)}`);
await page.screenshot({ path: "/tmp/funds-ui/funds-1440.png", fullPage: true });

await openStaff(`/customers?q=${encodeURIComponent(fundId)}`, "en", 1440);
text = await page.evaluate(() => document.body.innerText);
assert(text.includes("Customers") && text.includes(fundId), `list en ${text.slice(0, 240)}`);
await page.click(`a[href^='/customers/']`);
await page.waitForFunction(() => /\/customers\/\d+/.test(location.pathname));
await new Promise((r) => setTimeout(r, 500));
text = await page.evaluate(() => document.body.innerText);
assert(text.includes(fundId) && text.includes("Email") && text.includes("Deposits") && text.includes(reference), `detail ${text.slice(0, 500)}`);
await page.screenshot({ path: "/tmp/funds-ui/profile-1440.png", fullPage: true });

await openStaff("/funds?tab=withdrawals", "ms", 390);
text = await page.evaluate(() => document.body.innerText);
assert(text.includes("Pengeluaran") && text.includes("Deposit"), `ms ${text.slice(0, 240)}`);
assert((await overflow()) <= 24, `overflow 390 ${await overflow()}`);
await page.screenshot({ path: "/tmp/funds-ui/funds-390.png", fullPage: true });

const web = await browser.newPage();
await web.setViewport({ width: 1440, height: 900 });
await web.goto(WEB + "/login", { waitUntil: "domcontentloaded" });
await web.evaluate((token) => {
  localStorage.setItem("meridex.token", token);
  localStorage.setItem("meridex.lang", "zh");
  localStorage.setItem("meridex.tour", "done");
}, customer);
await web.goto(WEB + "/funds", { waitUntil: "networkidle0", timeout: 20000 });
await new Promise((r) => setTimeout(r, 500));
text = await web.evaluate(() => document.body.innerText);
assert(text.includes("资金账号") && text.includes(fundId), `wallet ${text.slice(0, 300)}`);
await web.screenshot({ path: "/tmp/funds-ui/wallet-1440.png" });
await web.setViewport({ width: 390, height: 844 });
await web.goto(WEB + "/funds/deposit", { waitUntil: "networkidle0", timeout: 20000 });
await new Promise((r) => setTimeout(r, 500));
text = await web.evaluate(() => document.body.innerText);
assert(text.includes(fundId) && text.includes("资金账号"), `deposit ref ${text.slice(0, 300)}`);
const extra = await web.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
assert(extra <= 24, `wallet overflow ${extra}`);
await web.screenshot({ path: "/tmp/funds-ui/deposit-390.png", fullPage: true });

await browser.close();
console.log("funds ui ok", fundId);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
