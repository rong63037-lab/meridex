/**
 * Browser check for the liquidity desk. Does not enable a provider.
 * Needs Chrome and puppeteer-core. Not part of `make test`.
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { totp } from "../gateway/src/crypto.ts";

const require = createRequire(new URL("../gateway/package.json", import.meta.url));
const puppeteer = require("/tmp/audit-deps/node_modules/puppeteer-core");
const ADMIN = "http://127.0.0.1:4318";
const GW = "http://127.0.0.1:7108";
const founder = ["founder@meridexexchange.com", "<redacted>", "<redacted>"];

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function api(path: string, token: string) {
  const res = await fetch(GW + path, { headers: { authorization: `Bearer ${token}`, "x-mock-country": "SG" } });
  const data = await res.json();
  return { status: res.status, data };
}

async function main() {
  const login = await fetch(GW + "/api/admin/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-mock-country": "SG" },
    body: JSON.stringify({ email: founder[0], password: founder[1], totp: totp(founder[2]) }),
  });
  const session = await login.json();
  assert(login.status === 200, `login ${login.status}`);
  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  mkdirSync("/tmp/liquidity-ui", { recursive: true });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (err: Error) => errors.push(String(err)));
  async function overflow() {
    return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  }
  async function open(lang: string, width: number) {
    await page.setViewport({ width, height: width === 390 ? 844 : 900 });
    await page.goto(ADMIN + "/login", { waitUntil: "domcontentloaded" });
    await page.evaluate((token: string, language: string) => {
      localStorage.setItem("meridex.staff.token", token);
      localStorage.setItem("meridex.lang", language);
    }, session.token, lang);
    await page.goto(ADMIN + "/liquidity", { waitUntil: "networkidle0", timeout: 20000 });
    await new Promise((r) => setTimeout(r, 500));
  }
  await open("zh", 1440);
  let text = await page.evaluate(() => document.body.innerText);
  assert(text.includes("流动性") && text.includes("紧急停止") && text.includes("未配置") && text.includes("测试连接"), `zh ${text.slice(0, 400)}`);
  assert(!text.includes("canary"), "page showed a secret");
  await page.screenshot({ path: "/tmp/liquidity-ui/zh-1440.png", fullPage: true });
  const wide = await overflow();
  assert(wide <= 24, `1440 overflow ${wide}`);

  await open("en", 1440);
  text = await page.evaluate(() => document.body.innerText);
  assert(text.includes("Liquidity") && text.includes("Kill switch") && text.includes("Missing"), `en ${text.slice(0, 400)}`);

  await open("ms", 390);
  text = await page.evaluate(() => document.body.innerText);
  assert(text.includes("Kecairan") && text.includes("Henti kecemasan"), `ms ${text.slice(0, 400)}`);
  const narrow = await overflow();
  assert(narrow <= 24, `390 overflow ${narrow}`);
  await page.screenshot({ path: "/tmp/liquidity-ui/ms-390.png", fullPage: true });
  assert(errors.length === 0, `console ${errors.join(";")}`);

  const state = await api("/api/admin/liquidity", session.token);
  const providers = state.data.providers as { mode: string; enabled: boolean }[];
  assert(state.data.kill === false, "kill was left on");
  assert(providers.every((row) => row.mode === "off" && row.enabled === false), "a provider was left on");
  await browser.close();
  console.log("liquidity ui ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
