/**
 * Browser checks for the real margin, perp, and copy desks.
 * Leaves every product switch OFF and paper trading OFF.
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { totp } from "../gateway/src/crypto.ts";

const require = createRequire(new URL("../gateway/package.json", import.meta.url));
const puppeteer = require("/tmp/audit-deps/node_modules/puppeteer-core") as {
  launch: (opts: Record<string, unknown>) => Promise<{
    newPage: () => Promise<Page>;
    close: () => Promise<void>;
  }>;
};

type Page = {
  goto: (url: string, opts?: Record<string, unknown>) => Promise<unknown>;
  setViewport: (v: { width: number; height: number }) => Promise<void>;
  evaluate: <T>(fn: (...args: never[]) => T, ...args: unknown[]) => Promise<T>;
  $: (sel: string) => Promise<unknown>;
  click: (sel: string) => Promise<void>;
  screenshot: (opts: { path: string; fullPage?: boolean }) => Promise<void>;
  close: () => Promise<void>;
};

const GW = "http://127.0.0.1:7108";
const WEB = "http://127.0.0.1:4317";
const ADMIN = "http://127.0.0.1:4318";
const FOUNDER = { email: "founder@meridexexchange.com", password: "<redacted>", secret: "<redacted>" };
const DEMO = { email: "client@meridexexchange.com", password: "<redacted>", secret: "<redacted>" };

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function call(path: string, token: string, body?: unknown) {
  const res = await fetch(`${GW}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-mock-country": "SG",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data: data as Record<string, unknown> };
}

async function login(email: string, password: string, secret: string, portal: "customer" | "staff") {
  const path = portal === "staff" ? "/api/admin/auth/login" : "/api/auth/login";
  const res = await call(path, "", { email, password, totp: totp(secret) });
  assert(res.status === 200 && typeof res.data.token === "string", `login ${email} ${res.status}`);
  return String(res.data.token);
}

async function textOf(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText);
}

async function overflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function openAs(page: Page, origin: string, token: string, path: string, lang: string, tokenKey = "meridex.token") {
  await page.goto(`${origin}/login`, { waitUntil: "domcontentloaded" });
  await page.evaluate((tok: string, language: string, key: string) => {
    localStorage.setItem(key, tok);
    localStorage.setItem("meridex.lang", language);
    localStorage.setItem("meridex.tour", "done");
  }, token, lang, tokenKey);
  await page.goto(`${origin}${path}`, { waitUntil: "networkidle0" });
}

async function main() {
  mkdirSync("/tmp/live-ui", { recursive: true });
  const founder = await login(FOUNDER.email, FOUNDER.password, FOUNDER.secret, "staff");
  const demo = await login(DEMO.email, DEMO.password, DEMO.secret, "customer");
  async function setSwitch(product: string, enabled: boolean) {
    const res = await call("/api/admin/live-products", founder, {
      product,
      enabled,
      maxNotionalUsd: "500.00",
      maxLeverage: 3,
      totp: totp(FOUNDER.secret),
    });
    assert(res.status === 200, `switch ${product} ${JSON.stringify(res.data)}`);
  }
  try {
    for (const product of ["margin", "perp", "copy"]) await setSwitch(product, false);
    await call("/api/paper", demo, { action: "disable" });

    const browser = await puppeteer.launch({
      executablePath: "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      for (const width of [1440, 390]) {
        const page = await browser.newPage();
        await page.setViewport({ width, height: width === 390 ? 844 : 900 });
        for (const path of ["/margin", "/perps", "/copy"]) {
          await openAs(page, WEB, demo, path, "zh");
          const text = await textOf(page);
          assert(text.includes("即将开放"), `${width} ${path} missing coming soon: ${text.slice(0, 240)}`);
          assert(!text.includes("内部流动性"), `${width} ${path} showed the live notice while off`);
          const badges = await page.evaluate(() => document.querySelectorAll(".mode-switch em").length);
          assert(badges === 0, `${width} ${path} showed ${badges} simulation badges while paper is off`);
          assert(!(await page.$("#live-qty")), `${width} ${path} showed an order ticket while off`);
          const extra = await overflow(page);
          assert(extra <= 1, `${width} ${path} overflow ${extra}`);
        }
        await page.screenshot({ path: `/tmp/live-ui/off-${width}.png`, fullPage: true });
        await page.close();
      }

      await setSwitch("perp", true);
      const live = await browser.newPage();
      await live.setViewport({ width: 1440, height: 900 });
      await openAs(live, WEB, demo, "/perps", "zh");
      let text = await textOf(live);
      assert(text.includes("内部流动性，尚未接入外部做市商"), `zh notice missing: ${text.slice(0, 400)}`);
      assert(text.includes("数量（克）"), `zh gram unit missing: ${text.slice(0, 500)}`);
      assert(text.includes("没有持仓。"), "missing empty positions");
      assert(text.includes("没有委托。"), "missing empty orders");
      assert(text.includes("没有历史委托。"), "missing empty history");
      assert(text.includes("没有成交。"), "missing empty fills");
      assert((await live.evaluate(() => document.querySelectorAll(".mode-switch em").length)) === 0, "live perp showed a simulation badge");
      assert(!text.includes("需牌照，暂未开放 · 模拟"), "live perp showed the paper licence badge");
      assert(await live.$("#live-qty"), "live ticket missing");
      await live.evaluate(() => {
        const input = document.querySelector("#live-lev") as HTMLInputElement;
        const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        proto?.set?.call(input, "3");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await new Promise((r) => setTimeout(r, 200));
      text = await textOf(live);
      assert(text.includes("我知道这个杠杆可能被强平"), `liquidation warning missing: ${text.slice(0, 700)}`);
      const maxLev = await live.evaluate(() => (document.querySelector("#live-lev") as HTMLInputElement | null)?.max);
      assert(maxLev === "3", `leverage max ${maxLev}`);
      await live.evaluate(() => {
        const input = document.querySelector("#live-qty") as HTMLInputElement;
        const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        proto?.set?.call(input, "0.001");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await live.click("form.panel button[type=submit]");
      await new Promise((r) => setTimeout(r, 300));
      text = await textOf(live);
      assert(text.includes("数量低于这个品种的最小下单量"), `min qty error missing: ${text.slice(0, 600)}`);
      await live.screenshot({ path: "/tmp/live-ui/perp-zh-1440.png", fullPage: true });

      await live.evaluate(() => {
        const card = [...document.querySelectorAll(".card")].find((el) => el.textContent?.includes("BTC-PERP"));
        (card as HTMLElement | undefined)?.click();
      });
      await new Promise((r) => setTimeout(r, 200));
      text = await textOf(live);
      assert(text.includes("数量（BTC）"), `btc unit missing: ${text.slice(0, 500)}`);
      assert(text.includes("最小跳动 $1.00"), "btc tick missing");

      await openAs(live, WEB, demo, "/perps", "en");
      text = await textOf(live);
      assert(text.includes("Internal liquidity, no external market maker yet"), "en notice missing");
      assert(text.includes("Quantity (g)"), "en gram unit missing");
      assert(text.includes("No positions."), "en empty positions missing");

      await openAs(live, WEB, demo, "/perps", "ms");
      text = await textOf(live);
      assert(text.includes("Kecairan dalaman, belum ada pembuat pasaran luar"), "ms notice missing");
      assert(text.includes("Kuantiti (g)"), "ms gram unit missing");
      assert(text.includes("Tiada posisi."), "ms empty positions missing");

      await live.setViewport({ width: 390, height: 844 });
      await openAs(live, WEB, demo, "/perps", "zh");
      const liveOverflow = await overflow(live);
      assert(liveOverflow <= 1, `live perp 390 overflow ${liveOverflow}`);
      await live.screenshot({ path: "/tmp/live-ui/perp-zh-390.png", fullPage: true });
      await live.close();

      await setSwitch("perp", false);
      await setSwitch("copy", true);
      const copy = await browser.newPage();
      await copy.setViewport({ width: 390, height: 844 });
      await openAs(copy, WEB, demo, "/copy", "zh");
      text = await textOf(copy);
      assert(text.includes("内部流动性，尚未接入外部做市商"), "copy notice missing");
      assert(text.includes("还没有交易员报名。") || text.includes("跟随"), "copy leaders section missing");
      assert(!text.includes("金衡") && !text.includes("回声乙") && !text.includes("北向丙"), "copy showed a fictional paper leader");
      assert((await copy.evaluate(() => document.querySelectorAll(".mode-switch em").length)) === 0, "copy showed a simulation badge");
      const copyOverflow = await overflow(copy);
      assert(copyOverflow <= 1, `copy 390 overflow ${copyOverflow}`);
      await copy.screenshot({ path: "/tmp/live-ui/copy-zh-390.png", fullPage: true });
      await copy.close();
      await setSwitch("copy", false);

      await call("/api/paper", demo, { action: "enable" });
      const paper = await browser.newPage();
      await paper.setViewport({ width: 1440, height: 900 });
      await openAs(paper, WEB, demo, "/perps", "zh");
      text = await textOf(paper);
      const badges = await paper.evaluate(() => document.querySelectorAll(".mode-switch em").length);
      assert(badges === 3, `paper badges ${badges}`);
      assert(text.includes("模拟"), "paper mode hid the simulation label");
      assert(!text.includes("内部流动性"), "paper perp showed the live notice");
      await paper.screenshot({ path: "/tmp/live-ui/paper-zh-1440.png", fullPage: true });
      await paper.close();
      await call("/api/paper", demo, { action: "disable" });

      const admin = await browser.newPage();
      await admin.setViewport({ width: 1440, height: 900 });
      await openAs(admin, ADMIN, founder, "/content", "zh", "meridex.staff.token");
      text = await textOf(admin);
      assert(text.includes("产品开关"), `admin switches missing: ${text.slice(0, 400)}`);
      assert(text.includes("杠杆") && text.includes("合约") && text.includes("跟单"), "admin product names missing");
      await admin.screenshot({ path: "/tmp/live-ui/admin-switches.png", fullPage: true });
      await openAs(admin, ADMIN, founder, "/deposits/reconcile", "zh", "meridex.staff.token");
      text = await textOf(admin);
      assert(text.includes("内部账本敞口"), "exposure heading missing");
      assert(text.includes("应付未付盈亏"), "pnl owed missing");
      assert(text.includes("没有未平仓位。") || text.includes("g") || text.includes("BTC"), `exposure body: ${text.slice(0, 700)}`);
      await admin.screenshot({ path: "/tmp/live-ui/admin-exposure.png", fullPage: false });
      await admin.close();
    } finally {
      await browser.close();
    }
  } finally {
    for (const product of ["margin", "perp", "copy"]) {
      await setSwitch(product, false).catch((err) => console.error(err));
    }
    await call("/api/paper", demo, { action: "disable" }).catch((err) => console.error(err));
  }
  console.log("live ui ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
