/**
 * Simple ticket and chart paint. Needs Chrome, the customer site on 4317, and the gateway.
 * Not part of `make test`.
 */
import { createRequire } from "node:module";
import { totp } from "../gateway/src/crypto.ts";

const require = createRequire(new URL("../gateway/package.json", import.meta.url));
const puppeteer = require("/tmp/audit-deps/node_modules/puppeteer-core");
const WEB = "http://127.0.0.1:4317";
const GW = "http://127.0.0.1:7108";

function assert(cond: unknown, message: string) {
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
  const session = await login.json();
  assert(login.status === 200 && session.token, `login ${login.status}`);

  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  const shots: string[] = [];
  async function open(width: number, lang: string, path: string) {
    await page.setViewport({ width, height: 844 });
    await page.goto(`${WEB}/login`, { waitUntil: "domcontentloaded" });
    await page.evaluate((token: string, next: string) => {
      localStorage.setItem("meridex.token", token);
      localStorage.setItem("meridex.tour", "done");
      localStorage.setItem("meridex.advanced", "0");
      localStorage.removeItem("meridex.simpleHint");
      localStorage.setItem("meridex.lang", next);
    }, session.token, lang);
    const started = Date.now();
    await page.goto(`${WEB}${path}`, { waitUntil: "domcontentloaded", timeout: 20000 });
    return started;
  }

  const nav = await open(1440, "zh", "/terminal?symbol=XAU%2FUSD");
  await page.waitForSelector("[data-testid=simple-order]", { timeout: 15000 });
  await page.waitForSelector(".chart-host canvas", { timeout: 15000 });
  const paint = await page.evaluate(() => {
    const mark = performance.getEntriesByName("meridex-chart-paint")[0];
    const box = window as Window & { __meridexTick?: { sentAt: number; recvAt: number; engineMs: number } };
    return { paintMs: mark ? Math.round(mark.startTime) : null, tick: box.__meridexTick ?? null };
  });
  const text = await page.$eval("[data-testid=simple-order]", (el) => el.textContent || "");
  assert(text.includes("买入") && text.includes("卖出"), "missing buy/sell");
  assert(text.includes("你支付") && text.includes("你得到"), text.slice(0, 180));
  assert(await page.$("[data-testid=trade-hint]"), "hint missing");
  assert(!(await page.$("[data-testid=simple-order] .tabs")), "simple ticket still shows order types");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 24, `1440 overflow ${overflow}`);
  await page.click("[data-testid=trade-hint] button");
  assert(!(await page.$("[data-testid=trade-hint]")), "hint stayed");
  shots.push(`zh1440 wall=${Date.now() - nav} paint=${paint.paintMs}`);

  await page.setViewport({ width: 390, height: 844 });
  await page.waitForSelector("[data-testid=simple-order]");
  const narrow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(narrow <= 24, `390 overflow ${narrow}`);

  await open(1440, "en", "/terminal?symbol=BTC%2FUSD");
  await page.waitForSelector("[data-testid=simple-order]");
  const en = await page.$eval("[data-testid=simple-order]", (el) => el.textContent || "");
  assert(en.includes("You pay") && en.includes("You receive"), en.slice(0, 160));
  const unit = await page.$eval("[data-testid=amount-qty]", (el) => el.textContent || "");
  assert(unit.includes("BTC"), `unit ${unit}`);

  await open(390, "ms", "/terminal?symbol=ETH%2FUSD");
  await page.waitForSelector("[data-testid=simple-order]");
  const ms = await page.$eval("[data-testid=simple-order]", (el) => el.textContent || "");
  assert(ms.includes("Anda bayar"), ms.slice(0, 160));
  const msOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(msOverflow <= 24, `ms 390 overflow ${msOverflow}`);
  const msUnit = await page.$eval("[data-testid=amount-qty]", (el) => el.textContent || "");
  assert(msUnit.includes("ETH"), `ms unit ${msUnit}`);

  for (const path of ["/margin", "/perps"]) {
    await open(390, "zh", path);
    await page.waitForFunction((needle: string) => document.body.innerText.includes(needle), { timeout: 15000 }, "即将开放");
    assert(!(await page.$("[data-testid=simple-order]")), `${path} showed a ticket while the product is off`);
  }

  const fps = await (async () => {
    await open(1440, "en", "/terminal?symbol=XAU%2FUSD");
    await page.waitForSelector(".chart-host canvas");
    await page.waitForFunction(new Function("return Boolean(window.__meridexTick)") as () => boolean, { timeout: 8000 });
    const tick = await page.evaluate(new Function(`
      const row = window.__meridexTick;
      return { sentAt: row.sentAt, recvAt: row.recvAt, paintedAt: row.paintedAt, engineMs: row.engineMs, screenMs: row.paintedAt - row.sentAt };
    `) as () => { screenMs: number; engineMs: number });
    console.log("tick-to-screen", JSON.stringify(tick));
    return page.evaluate(new Function(`
      return new Promise((resolve) => {
        let frames = 0;
        const start = performance.now();
        const step = (now) => {
          frames += 1;
          const host = document.querySelector(".chart-host");
          if (host) host.dispatchEvent(new WheelEvent("wheel", { deltaY: -30, bubbles: true }));
          if (now - start < 1000) requestAnimationFrame(step);
          else resolve(frames);
        };
        requestAnimationFrame(step);
      });
    `) as () => Promise<number>);
  })();

  await browser.close();
  const paper = await fetch(`${GW}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mock-country": "SG" },
    body: JSON.stringify({
      email: "client@meridexexchange.com",
      password: "<redacted>",
      totp: totp("<redacted>"),
    }),
  });
  const again = await paper.json();
  const state = await fetch(`${GW}/api/paper`, { headers: { authorization: `Bearer ${again.token}` } });
  const wallet = await state.json();
  assert(wallet.enabled === false, "demo paper was left on");
  console.log(`simple-ui ok ${shots.join(" ")} fps=${fps} paint=${paint.paintMs} tick=${JSON.stringify(paint.tick)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
