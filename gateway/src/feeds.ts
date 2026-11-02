import { FUTURES } from "./global.js";
import { noteFeeds } from "./feedStatus.js";
import { quietWarn } from "./net.js";
import { loadCatalog, type Instrument } from "./instruments.js";

export type FeedSource = "coingecko" | "binance" | "coinbase" | "kraken" | "gold-api" | "frankfurter" | "yahoo" | "gbm";

type Row = { anchor: number; micro: number; source: FeedSource; at: number };

const rows = new Map<string, Row>();

/** Annualised volatility used when every public feed is down. */
const VOL: Record<string, number> = {
  BTC: 0.55, ETH: 0.7, SOL: 0.9, XRP: 0.75, BNB: 0.65, ADA: 0.85, DOGE: 1.1, TRX: 0.6,
  AVAX: 0.9, DOT: 0.85, LINK: 0.8, TON: 0.9, LTC: 0.7, BCH: 0.75, POL: 0.9, SHIB: 1.2,
  NEAR: 0.95, ATOM: 0.85, UNI: 0.9, XLM: 0.75, APT: 0.95, ARB: 0.95, OP: 0.95, FIL: 0.9, ICP: 0.95,
  USDT: 0.015, USDC: 0.015, PAXG: 0.16, XAUT: 0.16,
  XAU: 0.15, XAG: 0.25, XPT: 0.22, XPD: 0.28, XAUKG: 0.15, XAUOZ: 0.15,
  BRENT: 0.35, WTI: 0.35, NATGAS: 0.65, COPPER: 0.25, ALUMINIUM: 0.22, NICKEL: 0.38,
  ZINC: 0.26, WHEAT: 0.3, CORN: 0.3, SOYBEAN: 0.26, COFFEE: 0.38, SUGAR: 0.32,
  EUR: 0.08, GBP: 0.09, JPY: 0.1, AUD: 0.11, SGD: 0.05, MYR: 0.07, CNH: 0.05, HKD: 0.01,
};

const BINANCE: Record<string, string> = {
  BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT", XRP: "XRPUSDT", BNB: "BNBUSDT", ADA: "ADAUSDT",
  DOGE: "DOGEUSDT", TRX: "TRXUSDT", AVAX: "AVAXUSDT", DOT: "DOTUSDT", LINK: "LINKUSDT", TON: "TONUSDT",
  LTC: "LTCUSDT", BCH: "BCHUSDT", POL: "POLUSDT", SHIB: "SHIBUSDT", NEAR: "NEARUSDT", ATOM: "ATOMUSDT",
  UNI: "UNIUSDT", XLM: "XLMUSDT", APT: "APTUSDT", ARB: "ARBUSDT", OP: "OPUSDT", FIL: "FILUSDT",
  ICP: "ICPUSDT", USDT: "USDTUSDT", USDC: "USDCUSDT", PAXG: "PAXGUSDT", XAUT: "XAUTUSDT",
};

const KRAKEN: Record<string, string> = {
  BTC: "XBTUSD", ETH: "ETHUSD", SOL: "SOLUSD", XRP: "XRPUSD", DOGE: "DOGEUSD", LTC: "LTCUSD",
  BCH: "BCHUSD", LINK: "LINKUSD", DOT: "DOTUSD", ATOM: "ATOMUSD", UNI: "UNIUSD", XLM: "XLMUSD",
  AVAX: "AVAXUSD", ADA: "ADAUSD", SHIB: "SHIBUSD", NEAR: "NEARUSD", FIL: "FILUSD", ICP: "ICPUSD",
  TON: "TONUSD", APT: "APTUSD", OP: "OPUSD", ARB: "ARBUSD", BNB: "BNBUSD", TRX: "TRXUSD", POL: "POLUSD",
  PAXG: "PAXGUSD", USDT: "USDTUSD", USDC: "USDCUSD",
};

const YEAR = 365.25 * 24 * 3600;

export function annualVol(inst: Instrument): number {
  return VOL[inst.base] ?? (inst.category === "crypto" ? 0.8 : inst.category === "fx" ? 0.08 : 0.3);
}

export function midFor(inst: Instrument): number {
  return rows.get(inst.symbol)?.micro ?? rows.get(inst.symbol)?.anchor ?? inst.refPrice;
}

export function anchorFor(inst: Instrument): number {
  return rows.get(inst.symbol)?.anchor ?? inst.refPrice;
}

export function sourceFor(symbol: string): FeedSource | null {
  return rows.get(symbol)?.source ?? null;
}

export function notePrint(symbol: string, price: number): void {
  const row = rows.get(symbol);
  if (!row || price <= 0) return;
  row.micro = price;
}

function snap(price: number, tick: number): number {
  const t = Math.max(1, tick);
  return Math.max(t, Math.round(price / t) * t);
}

function gauss(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function put(symbol: string, px: number, source: FeedSource, tick: number): void {
  const price = snap(px, tick);
  const prev = rows.get(symbol);
  if (!prev || prev.source !== source) {
    console.log(`feed ${symbol} source=${source} px=${price}`);
  }
  rows.set(symbol, {
    anchor: price,
    micro: prev?.micro && source !== "gbm" ? prev.micro : price,
    source,
    at: Date.now(),
  });
}

/** One GBM step. Used when no public print arrived for this symbol. */
export function walk(inst: Instrument, dtSec = 8): number {
  const prev = rows.get(inst.symbol);
  const elapsed = prev ? Math.max(1, (Date.now() - prev.at) / 1000) : dtSec;
  const dt = Math.min(elapsed, 3600) / YEAR;
  const vol = annualVol(inst);
  const base = prev?.anchor ?? inst.refPrice;
  const shock = Math.exp((-0.5 * vol * vol) * dt + vol * Math.sqrt(dt) * gauss());
  const next = snap(Math.max(inst.tickSize, base * shock), inst.tickSize);
  put(inst.symbol, next, "gbm", inst.tickSize);
  return next;
}

/** Touch price the maker should quote. Stays within a few ticks of the anchor. */
export function quoteMid(inst: Instrument): number {
  if (!rows.has(inst.symbol)) walk(inst, 8);
  const row = rows.get(inst.symbol)!;
  const tick = Math.max(1, inst.tickSize);
  const gap = row.anchor - row.micro;
  let next = Math.round(row.micro + gap * 0.55 + (Math.random() - 0.5) * 2 * tick);
  if (next === row.micro) next += Math.random() < 0.5 ? tick : -tick;
  const cap = tick * 8;
  next = Math.min(row.anchor + cap, Math.max(row.anchor - cap, next));
  row.micro = snap(next, tick);
  return row.micro;
}

async function grab(url: string): Promise<unknown | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json", "user-agent": "meridex-sandbox/1.0" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function usdToPx(usd: number, scale: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.max(1, Math.round(usd * scale));
}

/**
 * Platinum and commodities that gold-api did not price start from the latest
 * Yahoo futures print. Nickel and zinc have no trusted futures symbol, so they
 * stay on the random walk. Gold itself is not seeded here: it tracks gold-api
 * and falls back to the same walk when that feed is down.
 */
async function seedYahooStarts(catalog: Instrument[], got: Set<string>, counts: Record<FeedSource, number>): Promise<void> {
  const pending = catalog.filter((row) => {
    if (got.has(row.symbol) || !FUTURES[row.symbol]) return false;
    return row.category === "commodity" || row.symbol === "XPT/USD" || row.symbol === "XPD/USD";
  });
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < pending.length) {
      const row = pending[cursor];
      cursor += 1;
      const spec = FUTURES[row.symbol];
      if (!spec) continue;
      const body = await grab(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(spec.yahoo)}?interval=1d&range=5d`);
      const meta = body && typeof body === "object"
        ? (body as { chart?: { result?: { meta?: { regularMarketPrice?: number } }[] } }).chart?.result?.[0]?.meta
        : null;
      const last = Number(meta?.regularMarketPrice);
      if (!Number.isFinite(last) || last <= 0) continue;
      const px = usdToPx(last / spec.displayDivisor, row.priceScale);
      if (!px) continue;
      put(row.symbol, px, "yahoo", row.tickSize);
      got.add(row.symbol);
      counts.yahoo += 1;
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, () => worker()));
}

export async function refreshFeeds(): Promise<Record<FeedSource, number>> {
  const catalog = loadCatalog();
  const got = new Set<string>();
  const counts: Record<FeedSource, number> = {
    coingecko: 0, binance: 0, coinbase: 0, kraken: 0, "gold-api": 0, frankfurter: 0, yahoo: 0, gbm: 0,
  };

  const ids = [...new Set(catalog.filter((row) => row.feed.startsWith("coingecko:")).map((row) => row.feed.slice(10)))];
  const gecko = ids.length
    ? await grab(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd`)
    : null;
  const geckoMap = gecko && typeof gecko === "object" ? (gecko as Record<string, { usd?: number }>) : null;
  if (geckoMap) {
    for (const row of catalog) {
      if (!row.feed.startsWith("coingecko:")) continue;
      const usd = geckoMap[row.feed.slice(10)]?.usd;
      const px = usd ? usdToPx(usd, row.priceScale) : 0;
      if (!px) continue;
      put(row.symbol, px, "coingecko", row.tickSize);
      got.add(row.symbol);
      counts.coingecko += 1;
    }
  }

  const cryptoMissing = catalog.some((row) => row.category === "crypto" && !got.has(row.symbol));
  if (cryptoMissing) {
    const body = await grab("https://api.binance.com/api/v3/ticker/price");
    const list = Array.isArray(body) ? (body as { symbol?: string; price?: string }[]) : [];
    const bySymbol = new Map(list.map((row) => [row.symbol ?? "", Number(row.price)]));
    for (const row of catalog) {
      if (row.category !== "crypto" || got.has(row.symbol)) continue;
      const usd = bySymbol.get(BINANCE[row.base] ?? "");
      const px = usd ? usdToPx(usd, row.priceScale) : 0;
      if (!px) continue;
      put(row.symbol, px, "binance", row.tickSize);
      got.add(row.symbol);
      counts.binance += 1;
    }
  }

  if (catalog.some((row) => row.category === "crypto" && !got.has(row.symbol))) {
    const body = await grab("https://api.coinbase.com/v2/exchange-rates?currency=USD");
    const rates = body && typeof body === "object" ? (body as { data?: { rates?: Record<string, string> } }).data?.rates : null;
    if (rates) {
      for (const row of catalog) {
        if (row.category !== "crypto" || got.has(row.symbol)) continue;
        const perUsd = Number(rates[row.base]);
        const usd = perUsd > 0 ? 1 / perUsd : 0;
        const px = usd ? usdToPx(usd, row.priceScale) : 0;
        if (!px) continue;
        put(row.symbol, px, "coinbase", row.tickSize);
        got.add(row.symbol);
        counts.coinbase += 1;
      }
    }
  }

  const krakenLeft = catalog.filter((row) => row.category === "crypto" && !got.has(row.symbol) && KRAKEN[row.base]);
  if (krakenLeft.length) {
    const pairs = [...new Set(krakenLeft.map((row) => KRAKEN[row.base]))].join(",");
    const body = await grab(`https://api.kraken.com/0/public/Ticker?pair=${pairs}`);
    const result = body && typeof body === "object" ? (body as { result?: Record<string, { c?: string[] }> }).result : null;
    if (result) {
      const lastByPair = new Map<string, number>();
      for (const [key, value] of Object.entries(result)) {
        const last = Number(value?.c?.[0]);
        if (last > 0) lastByPair.set(key.toUpperCase().replace(/[^A-Z]/g, ""), last);
      }
      for (const row of krakenLeft) {
        const want = KRAKEN[row.base].toUpperCase();
        const usd = lastByPair.get(want) ?? [...lastByPair.entries()].find(([key]) => key.endsWith(want))?.[1];
        const px = usd ? usdToPx(usd, row.priceScale) : 0;
        if (!px) continue;
        put(row.symbol, px, "kraken", row.tickSize);
        got.add(row.symbol);
        counts.kraken += 1;
      }
    }
  }

  const oz = 31.1034768;
  for (const code of ["XAU", "XAG", "XPT", "XPD"] as const) {
    const body = await grab(`https://api.gold-api.com/price/${code}`);
    const price = body && typeof body === "object" ? Number((body as { price?: number }).price) : NaN;
    if (!Number.isFinite(price) || price <= 0) continue;
    const perGram = price / oz;
    const spot = catalog.find((row) => row.symbol === `${code}/USD`);
    if (spot) {
      const px = usdToPx(perGram, spot.priceScale);
      if (px) {
        put(spot.symbol, px, "gold-api", spot.tickSize);
        got.add(spot.symbol);
        counts["gold-api"] += 1;
      }
    }
    if (code === "XAU") {
      const kg = catalog.find((row) => row.symbol === "XAUKG/USD");
      const ounce = catalog.find((row) => row.symbol === "XAUOZ/USD");
      if (kg) {
        const px = usdToPx(perGram * 1000, kg.priceScale);
        if (px) {
          put(kg.symbol, px, "gold-api", kg.tickSize);
          got.add(kg.symbol);
          counts["gold-api"] += 1;
        }
      }
      if (ounce) {
        const px = usdToPx(price, ounce.priceScale);
        if (px) {
          put(ounce.symbol, px, "gold-api", ounce.tickSize);
          got.add(ounce.symbol);
          counts["gold-api"] += 1;
        }
      }
    }
  }
  const gold = rows.get("XAU/USD")?.anchor;
  const silver = rows.get("XAG/USD")?.anchor;
  const ratio = catalog.find((row) => row.symbol === "XAU/XAG");
  if (gold && silver && ratio) {
    const grams = (gold / 100) / (silver / 100);
    put(ratio.symbol, Math.max(1, Math.round(grams * ratio.priceScale)), got.has("XAU/USD") ? "gold-api" : "gbm", ratio.tickSize);
    got.add(ratio.symbol);
  }

  const fx = await grab("https://api.frankfurter.app/latest?from=USD&to=EUR,GBP,JPY,AUD,SGD,MYR,CNY,HKD");
  const rates = fx && typeof fx === "object" ? (fx as { rates?: Record<string, number> }).rates : null;
  if (rates) {
    const map: Record<string, string> = { EUR: "EUR/USD", GBP: "GBP/USD", JPY: "JPY/USD", AUD: "AUD/USD", SGD: "SGD/USD", MYR: "MYR/USD", CNY: "CNH/USD", HKD: "HKD/USD" };
    for (const [code, symbol] of Object.entries(map)) {
      const foreignPerUsd = rates[code];
      const inst = catalog.find((row) => row.symbol === symbol);
      if (!inst || !foreignPerUsd) continue;
      const px = usdToPx(1 / foreignPerUsd, inst.priceScale);
      if (!px) continue;
      put(symbol, px, "frankfurter", inst.tickSize);
      got.add(symbol);
      counts.frankfurter += 1;
    }
  }

  await seedYahooStarts(catalog, got, counts);

  for (const row of catalog) {
    if (got.has(row.symbol)) continue;
    walk(row, 8);
    counts.gbm += 1;
  }

  const summary = (Object.entries(counts) as [FeedSource, number][]).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(" ");
  console.log(`feeds ${summary}`);
  noteFeeds(counts, null);
  return counts;
}

let feedTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = 8_000;

export function startFeedLoop(): void {
  if (feedTimer) return;
  const loop = async () => {
    try {
      const counts = await refreshFeeds();
      const remote = counts.coingecko + counts.binance + counts.coinbase + counts.kraken + counts["gold-api"] + counts.frankfurter + counts.yahoo;
      backoffMs = remote > 0 ? 8_000 : Math.min(60_000, backoffMs * 2);
    } catch (err) {
      const message = err instanceof Error ? err.message : "unavailable";
      noteFeeds(null, message);
      backoffMs = Math.min(60_000, backoffMs * 2);
      quietWarn("feeds", `feeds backing off ${backoffMs}ms (${message})`);
    }
    feedTimer = setTimeout(loop, backoffMs);
  };
  feedTimer = setTimeout(loop, 8_000);
}

export function clampToBand(inst: Instrument, price: number, haltLow?: number, haltHigh?: number): number {
  const tick = Math.max(1, inst.tickSize);
  const lo = haltLow ?? Math.floor(inst.refPrice * (10_000 - inst.haltBps) / 10_000) + tick * 2;
  const hi = haltHigh ?? Math.floor(inst.refPrice * (10_000 + inst.haltBps) / 10_000) - tick * 2;
  const floor = Math.min(lo, hi);
  const ceiling = Math.max(lo, hi);
  const clamped = Math.min(ceiling - tick, Math.max(floor + tick, price));
  return snap(clamped, tick);
}
