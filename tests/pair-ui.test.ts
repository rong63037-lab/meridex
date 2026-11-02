/**
 * Click non-crypto pairs on the desk, including the price cell, the category tabs,
 * a direct URL, and the simple ticket. Needs Chrome and the customer site on 4317.
 * Not part of `make test`.
 */
import { createRequire } from "node:module";
import { totp } from "../gateway/src/crypto.ts";

const require = createRequire(new URL("../gateway/package.json", import.meta.url));
const puppeteer = require("/tmp/audit-deps/node_modules/puppeteer-core");
const WEB = "http://127.0.0.1:4317";
const GW = "http://127.0.0.1:7108";

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function main() {
  const login = await fetch(`${GW}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mock-country": "SG" },
    body: JSON.stringify({
      email: "client@meridexexchange.com",
      password: "<redacted>",
      totp: totp("<redacted>"),
    }),
  });
  const session = await login.json() as { token?: string };
  assert(login.status === 200 && session.token, `login ${login.status}`);

  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (err: Error) => errors.push(err.message));

  async function boot(path: string, advanced: "0" | "1") {
    await page.goto(`${WEB}/login`, { waitUntil: "domcontentloaded" });
    await page.evaluate((token: string, mode: string) => {
      localStorage.setItem("meridex.token", token);
      localStorage.setItem("meridex.tour", "done");
      localStorage.setItem("meridex.lang", "zh");
      localStorage.setItem("meridex.advanced", mode);
      localStorage.removeItem("meridex.symbol");
    }, session.token, advanced);
    await page.goto(`${WEB}${path}`, { waitUntil: "domcontentloaded", timeout: 25000 });
  }

  async function shown() {
    return page.$eval("strong[data-symbol]", (el) => el.getAttribute("data-symbol"));
  }

  async function clickPrice(symbol: string) {
    const point = await page.evaluate((sym: string) => {
      const row = document.querySelector(`.mkts .mkt-row[data-symbol="${sym}"]`);
      const price = row?.querySelector(".num");
      if (!row || !price) return null;
      row.scrollIntoView({ block: "center" });
      const rect = price.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, symbol);
    assert(point, `no price cell for ${symbol}`);
    await page.mouse.click(point.x, point.y);
    await new Promise((r) => setTimeout(r, 400));
  }

  for (const width of [1440, 1280, 1024]) {
    await page.setViewport({ width, height: 800 });
    await boot("/terminal?symbol=BTC%2FUSD", "1");
    await page.waitForSelector(".mkts .mkt-row[data-symbol='EUR/USD']", { timeout: 15000 });
    await clickPrice("EUR/USD");
    assert(await shown() === "EUR/USD", `${width} price click stayed on ${await shown()}`);
    assert(page.url().includes("EUR%2FUSD"), `${width} url ${page.url()}`);

    await page.click(".mkts [data-cat=fx]");
    await clickPrice("GBP/USD");
    assert(await shown() === "GBP/USD", `${width} fx tab ${await shown()}`);
    await page.click(".mkts [data-cat=metal]");
    await clickPrice("XAU/USD");
    assert(await shown() === "XAU/USD", `${width} metal tab ${await shown()}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(overflow <= 24, `${width} overflow ${overflow}`);
  }

  await page.setViewport({ width: 1440, height: 800 });
  await boot("/terminal?symbol=XAU%2FXAG", "1");
  await page.waitForSelector("strong[data-symbol]", { timeout: 15000 });
  assert(await shown() === "XAU/XAG", `direct ratio ${await shown()}`);
  await boot("/terminal?symbol=BRENT%2FUSD", "1");
  await page.waitForSelector("strong[data-symbol]", { timeout: 15000 });
  assert(await shown() === "BRENT/USD", `direct brent ${await shown()}`);

  await boot("/terminal?symbol=BTC%2FUSD", "0");
  await page.waitForSelector("[data-testid=simple-order]", { timeout: 15000 });
  const choices = await page.$$eval(".symbol-pick option", (els) => els.map((el) => (el as HTMLOptionElement).value));
  for (const symbol of ["EUR/USD", "XAU/USD", "BRENT/USD"]) assert(choices.includes(symbol), `simple list missing ${symbol}`);
  await page.select(".symbol-pick", "EUR/USD");
  await new Promise((r) => setTimeout(r, 300));
  assert(await shown() === "EUR/USD", `simple select ${await shown()}`);

  await page.setRequestInterception(true);
  page.on("request", (req: { url: () => string; abort: (e?: string) => Promise<void>; continue: () => Promise<void> }) => {
    const url = req.url();
    if (url.includes("/api/market/candles") && url.includes("XPT")) void req.abort("failed");
    else void req.continue();
  });
  await boot("/terminal?symbol=XPT%2FUSD", "1");
  await page.waitForSelector("[data-testid=quote-unavailable]", { timeout: 15000 });
  const text = await page.$eval("[data-testid=quote-unavailable]", (el) => el.textContent || "");
  assert(text.includes("报价暂时不可用") && text.includes("重试"), text);
  assert(await shown() === "XPT/USD", "failed quote still shows the symbol");

  assert(errors.length === 0, errors.join(" | "));
  await browser.close();
  console.log("pair-ui ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
