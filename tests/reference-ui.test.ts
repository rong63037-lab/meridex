/**
 * Reference panel stays hidden while the switch is off, and is labelled when on.
 * Not part of `make test`. Leaves the switch OFF.
 */
import { createRequire } from "node:module";
import { totp } from "../gateway/src/crypto.ts";

const require = createRequire(new URL("../gateway/package.json", import.meta.url));
const puppeteer = require("/tmp/audit-deps/node_modules/puppeteer-core");
const WEB = "http://127.0.0.1:4317";
const GW = "http://127.0.0.1:7108";
const FOUNDER = { email: "founder@meridexexchange.com", password: "<redacted>", secret: "<redacted>" };

function assert(cond: unknown, message: string) {
  if (!cond) throw new Error(message);
}

async function login(path: string, email: string, password: string, secret: string) {
  const res = await fetch(`${GW}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mock-country": "SG" },
    body: JSON.stringify({ email, password, totp: totp(secret) }),
  });
  const data = await res.json();
  assert(res.status === 200 && data.token, `login ${email} ${res.status}`);
  return String(data.token);
}

async function main() {
  const customer = await login("/api/auth/login", "client@meridexexchange.com", "<redacted>", "<redacted>");
  const founder = await login("/api/admin/auth/login", FOUNDER.email, FOUNDER.password, FOUNDER.secret);
  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 390, height: 844 });
    await page.goto(`${WEB}/login`, { waitUntil: "domcontentloaded" });
    await page.evaluate((token: string) => {
      localStorage.setItem("meridex.token", token);
      localStorage.setItem("meridex.tour", "done");
      localStorage.setItem("meridex.advanced", "0");
      localStorage.setItem("meridex.lang", "zh");
      localStorage.setItem("meridex.simpleHint", "off");
    }, customer);
    const started = Date.now();
    await page.goto(`${WEB}/terminal?symbol=BTC%2FUSD`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForSelector("[data-testid=simple-order]", { timeout: 15000 });
    await page.waitForSelector(".chart-host canvas", { timeout: 15000 });
    const paint = await page.evaluate(() => {
      const mark = performance.getEntriesByName("meridex-chart-paint")[0] as PerformanceEntry | undefined;
      return mark ? Math.round(mark.startTime) : null;
    });
    assert(!(await page.$("[data-testid=reference-depth]")), "reference panel showed while the switch is off");
    const offOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(offOverflow <= 24, `off overflow ${offOverflow}`);
    console.log(`reference hidden paint=${paint} wall=${Date.now() - started}`);

    const on = await fetch(`${GW}/api/admin/reference-depth`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${founder}` },
      body: JSON.stringify({ enabled: true, totp: totp(FOUNDER.secret) }),
    });
    assert(on.status === 200, `enable ${on.status}`);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-testid=reference-depth]", { timeout: 20000 });
    await page.waitForSelector("[data-testid=simple-order]");
    const label = await page.$eval("[data-testid=reference-depth]", (el) => el.textContent || "");
    assert(label.includes("参考行情"), label.slice(0, 180));
    assert(label.includes("不是本平台的流动性"), label.slice(0, 220));
    const inside = await page.$("[data-testid=simple-order] [data-testid=reference-depth]");
    assert(!inside, "reference panel was placed inside the order ticket");
    const narrow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(narrow <= 24, `on overflow ${narrow}`);

    await page.goto(`${WEB}/perps`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForFunction(new Function("return document.body.innerText.includes('即将开放')") as () => boolean, { timeout: 15000 });
    await page.waitForSelector("[data-testid=reference-depth]", { timeout: 20000 });
    assert(!(await page.$("[data-testid=simple-order]")), "perps showed a ticket while the product is off");
    const perp = await page.$eval("[data-testid=reference-depth]", (el) => el.textContent || "");
    assert(perp.includes("参考行情"), perp.slice(0, 160));
    const perpOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(perpOverflow <= 24, `perps overflow ${perpOverflow}`);
    console.log("reference-ui ok");
  } finally {
    await browser.close();
    await fetch(`${GW}/api/admin/reference-depth`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${founder}` },
      body: JSON.stringify({ enabled: false, totp: totp(FOUNDER.secret) }),
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
