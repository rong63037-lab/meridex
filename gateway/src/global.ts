/** External reference quotes. Numbers are copied from a public source or left null. */
import { noteCandles } from "./feedStatus.js";
import { loadCatalog, type Instrument } from "./instruments.js";
import { sleep } from "./net.js";

export type GlobalKind = "aggregate" | "exchange" | "futures" | "otc" | "none";

export type GlobalView = {
  symbol: string;
  kind: GlobalKind;
  source: string | null;
  volumeBase: number | null;
  volumeUsd: number | null;
  high: number | null;
  low: number | null;
  last: number | null;
  change: number | null;
  updatedAt: number | null;
  delayed: boolean;
  note: string;
};

type Cached = GlobalView;

const DELAY_MS = 180_000;
const OZ = 31.1034768;

type Fut = {
  yahoo: string;
  quotedUnits: number;
  quoteDivisor: number;
  basePerContract: number;
  displayDivisor: number;
  note: string;
};

/** Yahoo futures whose contract size is published. Zinc and nickel are omitted on purpose. */
export const FUTURES: Record<string, Fut> = {
  "XAU/USD": { yahoo: "GC=F", quotedUnits: 100, quoteDivisor: 1, basePerContract: 100 * OZ, displayDivisor: OZ, note: "Yahoo Finance GC=F · COMEX 100 oz" },
  "XAUOZ/USD": { yahoo: "GC=F", quotedUnits: 100, quoteDivisor: 1, basePerContract: 100, displayDivisor: 1, note: "Yahoo Finance GC=F · COMEX 100 oz" },
  "XAUKG/USD": { yahoo: "GC=F", quotedUnits: 100, quoteDivisor: 1, basePerContract: (100 * OZ) / 1000, displayDivisor: OZ / 1000, note: "Yahoo Finance GC=F · COMEX 100 oz" },
  "XAG/USD": { yahoo: "SI=F", quotedUnits: 5000, quoteDivisor: 1, basePerContract: 5000 * OZ, displayDivisor: OZ, note: "Yahoo Finance SI=F · COMEX 5,000 oz" },
  "XPT/USD": { yahoo: "PL=F", quotedUnits: 50, quoteDivisor: 1, basePerContract: 50 * OZ, displayDivisor: OZ, note: "Yahoo Finance PL=F · NYMEX 50 oz" },
  "XPD/USD": { yahoo: "PA=F", quotedUnits: 100, quoteDivisor: 1, basePerContract: 100 * OZ, displayDivisor: OZ, note: "Yahoo Finance PA=F · NYMEX 100 oz" },
  "WTI/USD": { yahoo: "CL=F", quotedUnits: 1000, quoteDivisor: 1, basePerContract: 1000, displayDivisor: 1, note: "Yahoo Finance CL=F · NYMEX 1,000 bbl" },
  "BRENT/USD": { yahoo: "BZ=F", quotedUnits: 1000, quoteDivisor: 1, basePerContract: 1000, displayDivisor: 1, note: "Yahoo Finance BZ=F · 1,000 bbl" },
  "NATGAS/USD": { yahoo: "NG=F", quotedUnits: 10000, quoteDivisor: 1, basePerContract: 10000, displayDivisor: 1, note: "Yahoo Finance NG=F · 10,000 MMBtu" },
  "COPPER/USD": { yahoo: "HG=F", quotedUnits: 25000, quoteDivisor: 1, basePerContract: 25000, displayDivisor: 1, note: "Yahoo Finance HG=F · 25,000 lb" },
  "ALUMINIUM/USD": { yahoo: "ALI=F", quotedUnits: 25, quoteDivisor: 1, basePerContract: 25, displayDivisor: 1, note: "Yahoo Finance ALI=F · 25 t" },
  "WHEAT/USD": { yahoo: "ZW=F", quotedUnits: 5000, quoteDivisor: 100, basePerContract: 5000, displayDivisor: 100, note: "Yahoo Finance ZW=F · 5,000 bu, quoted in cents" },
  "CORN/USD": { yahoo: "ZC=F", quotedUnits: 5000, quoteDivisor: 100, basePerContract: 5000, displayDivisor: 100, note: "Yahoo Finance ZC=F · 5,000 bu, quoted in cents" },
  "SOYBEAN/USD": { yahoo: "ZS=F", quotedUnits: 5000, quoteDivisor: 100, basePerContract: 5000, displayDivisor: 100, note: "Yahoo Finance ZS=F · 5,000 bu, quoted in cents" },
  "COFFEE/USD": { yahoo: "KC=F", quotedUnits: 37500, quoteDivisor: 100, basePerContract: 37500, displayDivisor: 100, note: "Yahoo Finance KC=F · 37,500 lb, quoted in cents" },
  "SUGAR/USD": { yahoo: "SB=F", quotedUnits: 112000, quoteDivisor: 100, basePerContract: 112000, displayDivisor: 100, note: "Yahoo Finance SB=F · 112,000 lb, quoted in cents" },
};

const NO_VOLUME = new Set(["XAU/XAG", "NICKEL/USD", "ZINC/USD"]);

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

const OKX_BAR: Record<string, string> = { "1m": "1m", "5m": "5m", "15m": "15m", "1H": "1H", "4H": "4H", "1D": "1D" };
const YAHOO_BAR: Record<string, { interval: string; range: string }> = {
  "1m": { interval: "1m", range: "1d" },
  "5m": { interval: "5m", range: "5d" },
  "15m": { interval: "15m", range: "5d" },
  "1H": { interval: "60m", range: "1mo" },
  "4H": { interval: "60m", range: "3mo" },
  "1D": { interval: "1d", range: "6mo" },
};

export type GlobalResponse = { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> };
type Fetcher = (url: string) => Promise<GlobalResponse | null>;

let fetcher: Fetcher = defaultFetch;
const cache = new Map<string, Cached>();
const barsCache = new Map<string, { at: number; bars: { time: number; volume: number }[] }>();

export function setGlobalFetch(next: Fetcher | null): void {
  fetcher = next ?? defaultFetch;
}

export function resetGlobalCache(): void {
  cache.clear();
  barsCache.clear();
}

function empty(symbol: string, kind: GlobalKind, note: string): GlobalView {
  return {
    symbol, kind, source: null, volumeBase: null, volumeUsd: null, high: null, low: null, last: null,
    change: null, updatedAt: null, delayed: false, note,
  };
}

function baseline(inst: Instrument): GlobalView {
  if (inst.category === "fx") return empty(inst.symbol, "otc", "OTC market");
  if (NO_VOLUME.has(inst.symbol)) return empty(inst.symbol, "none", "No reliable public volume");
  if (FUTURES[inst.symbol]) return empty(inst.symbol, "futures", FUTURES[inst.symbol].note);
  if (inst.category === "crypto") return empty(inst.symbol, "aggregate", "CoinGecko aggregate 24h volume");
  return empty(inst.symbol, "none", "No reliable public volume");
}

export function globalView(symbol: string, now = Date.now()): GlobalView {
  const hit = cache.get(symbol);
  if (!hit) {
    const inst = loadCatalog().find((row) => row.symbol === symbol);
    return inst ? baseline(inst) : empty(symbol, "none", "No reliable public volume");
  }
  const delayed = hit.updatedAt != null && hit.kind !== "otc" && hit.kind !== "none" && now - hit.updatedAt > DELAY_MS;
  return { ...hit, delayed };
}

export function allGlobal(now = Date.now()): GlobalView[] {
  return loadCatalog().map((row) => globalView(row.symbol, now));
}

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function positive(value: unknown): number | null {
  const n = num(value);
  return n != null && n > 0 ? n : null;
}

export async function refreshGlobal(now = Date.now()): Promise<void> {
  const catalog = loadCatalog();
  for (const inst of catalog) {
    if (!cache.has(inst.symbol)) cache.set(inst.symbol, baseline(inst));
  }
  const updates = new Map<string, GlobalView>();
  await fillCrypto(catalog, updates, now);
  await fillFutures(updates, now);
  for (const [symbol, view] of updates) cache.set(symbol, view);
}

async function fillCrypto(catalog: Instrument[], updates: Map<string, GlobalView>, now: number): Promise<void> {
  const crypto = catalog.filter((row) => row.category === "crypto");
  const ids = [...new Set(crypto.map((row) => (row.feed.startsWith("coingecko:") ? row.feed.slice(10) : "")).filter(Boolean))];
  const gecko = ids.length
    ? await fetchJson(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids.join(",")}&per_page=250&page=1`)
    : null;
  const byId = new Map<string, { volume: number | null; last: number | null; high: number | null; low: number | null; change: number | null }>();
  if (Array.isArray(gecko)) {
    for (const row of gecko as Record<string, unknown>[]) {
      const id = typeof row.id === "string" ? row.id : "";
      if (!id) continue;
      byId.set(id, {
        volume: positive(row.total_volume),
        last: positive(row.current_price),
        high: positive(row.high_24h),
        low: positive(row.low_24h),
        change: num(row.price_change_percentage_24h),
      });
    }
  }
  const missing: Instrument[] = [];
  for (const inst of crypto) {
    const id = inst.feed.startsWith("coingecko:") ? inst.feed.slice(10) : "";
    const row = byId.get(id);
    if (!row || row.volume == null) {
      missing.push(inst);
      continue;
    }
    const last = row.last;
    updates.set(inst.symbol, {
      ...baseline(inst),
      kind: "aggregate",
      source: "CoinGecko",
      volumeUsd: row.volume,
      volumeBase: last ? row.volume / last : null,
      high: row.high,
      low: row.low,
      last,
      change: row.change == null ? null : row.change / 100,
      updatedAt: now,
      note: "CoinGecko aggregate 24h volume",
    });
  }
  if (!missing.length) return;

  const binance = await fetchJson("https://api.binance.com/api/v3/ticker/24hr");
  const binanceBy = new Map<string, Record<string, unknown>>();
  if (Array.isArray(binance)) {
    for (const row of binance as Record<string, unknown>[]) {
      if (typeof row.symbol === "string") binanceBy.set(row.symbol, row);
    }
  }
  const still: Instrument[] = [];
  for (const inst of missing) {
    const row = binanceBy.get(BINANCE[inst.base] ?? "");
    const quote = positive(row?.quoteVolume);
    const base = positive(row?.volume);
    if (!row || quote == null) {
      still.push(inst);
      continue;
    }
    const last = positive(row.lastPrice);
    const open = positive(row.openPrice);
    updates.set(inst.symbol, exchangeView(inst, "Binance", base, quote, positive(row.highPrice), positive(row.lowPrice), last, open, now));
  }
  if (!still.length) return;

  const okx = await fetchJson("https://www.okx.com/api/v5/market/tickers?instType=SPOT");
  const okxBy = new Map<string, Record<string, unknown>>();
  const okxRows = okx && typeof okx === "object" ? (okx as { data?: Record<string, unknown>[] }).data : null;
  if (Array.isArray(okxRows)) {
    for (const row of okxRows) {
      if (typeof row.instId === "string") okxBy.set(row.instId, row);
    }
  }
  const afterOkx: Instrument[] = [];
  for (const inst of still) {
    const row = okxBy.get(`${inst.base}-USDT`);
    const quote = positive(row?.volCcy24h);
    const base = positive(row?.vol24h);
    if (!row || (quote == null && base == null)) {
      afterOkx.push(inst);
      continue;
    }
    const last = positive(row.last);
    const usd = quote ?? (base != null && last ? base * last : null);
    const open = positive(row.open24h);
    updates.set(inst.symbol, exchangeView(inst, "OKX", base, usd, positive(row.high24h), positive(row.low24h), last, open, now));
  }
  if (!afterOkx.length) return;

  const pairs = [...new Set(afterOkx.map((row) => KRAKEN[row.base]).filter(Boolean))];
  const kraken = pairs.length ? await fetchJson(`https://api.kraken.com/0/public/Ticker?pair=${pairs.join(",")}`) : null;
  const krakenResult = kraken && typeof kraken === "object" ? (kraken as { result?: Record<string, { c?: string[]; v?: string[]; h?: string[]; l?: string[]; o?: string }> }).result : null;
  const krakenBy = new Map<string, { base: number | null; high: number | null; low: number | null; last: number | null; open: number | null }>();
  if (krakenResult) {
    for (const [key, value] of Object.entries(krakenResult)) {
      krakenBy.set(key.toUpperCase().replace(/[^A-Z]/g, ""), {
        base: positive(value.v?.[1]),
        high: positive(value.h?.[1]),
        low: positive(value.l?.[1]),
        last: positive(value.c?.[0]),
        open: positive(value.o),
      });
    }
  }
  const afterKraken: Instrument[] = [];
  for (const inst of afterOkx) {
    const want = (KRAKEN[inst.base] ?? "").toUpperCase();
    const row = krakenBy.get(want) ?? [...krakenBy.entries()].find(([key]) => want && key.endsWith(want))?.[1];
    if (!row || row.base == null || row.last == null) {
      afterKraken.push(inst);
      continue;
    }
    updates.set(inst.symbol, exchangeView(inst, "Kraken", row.base, row.base * row.last, row.high, row.low, row.last, row.open, now));
  }

  for (const inst of afterKraken) {
    const body = await fetchJson(`https://api.exchange.coinbase.com/products/${inst.base}-USD/stats`);
    const row = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
    const base = positive(row?.volume);
    const last = positive(row?.last);
    if (base == null || last == null) continue;
    const open = positive(row?.open);
    updates.set(inst.symbol, exchangeView(inst, "Coinbase", base, base * last, positive(row?.high), positive(row?.low), last, open, now));
  }
}

function exchangeView(inst: Instrument, source: string, base: number | null, usd: number | null, high: number | null, low: number | null, last: number | null, open: number | null, now: number): GlobalView {
  return {
    ...baseline(inst),
    kind: "exchange",
    source,
    volumeBase: base,
    volumeUsd: usd,
    high, low, last,
    change: last != null && open ? (last - open) / open : null,
    updatedAt: now,
    note: `${source} single-exchange 24h ticker, not an all-venue total`,
  };
}

async function fillFutures(updates: Map<string, GlobalView>, now: number): Promise<void> {
  const entries = Object.entries(FUTURES);
  let cursor = 0;
  async function worker() {
    while (cursor < entries.length) {
      const index = cursor;
      cursor += 1;
      const [symbol, spec] = entries[index];
      const body = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(spec.yahoo)}?interval=1d&range=5d`);
      const meta = yahooMeta(body);
      if (!meta) continue;
      const price = positive(meta.regularMarketPrice);
      const high = positive(meta.regularMarketDayHigh);
      const low = positive(meta.regularMarketDayLow);
      const prev = positive(meta.chartPreviousClose);
      const contracts = positive(meta.regularMarketVolume);
      const show = (px: number | null) => (px == null ? null : px / spec.displayDivisor);
      updates.set(symbol, {
        symbol,
        kind: "futures",
        source: "Yahoo Finance",
        volumeBase: contracts == null ? null : contracts * spec.basePerContract,
        volumeUsd: contracts == null || price == null ? null : contracts * spec.quotedUnits * (price / spec.quoteDivisor),
        high: show(high),
        low: show(low),
        last: show(price),
        change: price != null && prev ? (price - prev) / prev : null,
        updatedAt: now,
        delayed: false,
        note: spec.note,
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, () => worker()));
}

function yahooMeta(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const result = (body as { chart?: { result?: { meta?: Record<string, unknown> }[] } }).chart?.result?.[0]?.meta;
  return result ?? null;
}

export async function globalVolumeBars(symbol: string, tf: string, now = Date.now()): Promise<{ time: number; volume: number }[] | null> {
  const key = `${symbol}|${tf}`;
  const hit = barsCache.get(key);
  if (hit && now - hit.at < 60_000) return hit.bars;
  const inst = loadCatalog().find((row) => row.symbol === symbol);
  if (!inst) return null;
  const bars = inst.category === "crypto" ? await cryptoBars(inst, tf) : await futureBars(inst.symbol, tf);
  if (!bars) return hit?.bars ?? null;
  barsCache.set(key, { at: now, bars });
  return bars;
}

async function cryptoBars(inst: Instrument, tf: string): Promise<{ time: number; volume: number }[] | null> {
  const pair = BINANCE[inst.base];
  const interval = { "1m": "1m", "5m": "5m", "15m": "15m", "1H": "1h", "4H": "4h", "1D": "1d" }[tf];
  if (pair && interval) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const body = await fetchJson(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=300`);
      if (Array.isArray(body) && body.length) {
        const bars = (body as [number, string, string, string, string, string][])
          .map((row) => ({ time: Math.floor(row[0] / 1000), volume: positive(row[5]) }))
          .filter((row): row is { time: number; volume: number } => row.volume != null);
        if (bars.length) {
          noteCandles("binance", null);
          return bars;
        }
      }
      if (attempt < 2) await sleep(200 * 2 ** attempt);
    }
    noteCandles("local", "binance klines unavailable");
  }
  const bar = OKX_BAR[tf];
  if (!bar) return null;
  const body = await fetchJson(`https://www.okx.com/api/v5/market/candles?instId=${inst.base}-USDT&bar=${bar}&limit=300`);
  const rows = body && typeof body === "object" ? (body as { data?: string[][] }).data : null;
  if (!Array.isArray(rows)) return null;
  const bars = rows
    .map((row) => ({ time: Math.floor(Number(row[0]) / 1000), volume: positive(row[5]) }))
    .filter((row): row is { time: number; volume: number } => row.volume != null);
  return bars.length ? bars : null;
}

async function futureBars(symbol: string, tf: string): Promise<{ time: number; volume: number }[] | null> {
  const spec = FUTURES[symbol];
  const span = YAHOO_BAR[tf];
  if (!spec || !span) return null;
  const body = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(spec.yahoo)}?interval=${span.interval}&range=${span.range}`);
  const result = body && typeof body === "object"
    ? (body as { chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { volume?: (number | null)[] }[] } }[] } }).chart?.result?.[0]
    : null;
  const times = result?.timestamp;
  const volumes = result?.indicators?.quote?.[0]?.volume;
  if (!times || !volumes) return null;
  const sec = tf === "4H" ? 14400 : tf === "1D" ? 86400 : tf === "1H" ? 3600 : tf === "15m" ? 900 : tf === "5m" ? 300 : 60;
  const buckets = new Map<number, number>();
  for (let i = 0; i < times.length; i++) {
    const contracts = positive(volumes[i]);
    if (contracts == null) continue;
    const bucket = Math.floor(times[i] / sec) * sec;
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + contracts * spec.basePerContract);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([time, volume]) => ({ time, volume }));
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetcher(url);
    if (!res || !res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function defaultFetch(url: string): Promise<GlobalResponse | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json", "user-agent": "meridex-sandbox/1.0" } });
    if (!res.ok) return { ok: false, status: res.status, json: async () => null, text: async () => "" };
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;

export async function startGlobalLoop(): Promise<void> {
  if (timer) return;
  const loop = async () => {
    try {
      await refreshGlobal();
      const fresh = [...cache.values()].filter((row) => row.source).length;
      console.log(`global quotes=${fresh}`);
    } catch (err) {
      console.error("global", err);
    }
    timer = setTimeout(loop, 60_000);
  };
  await loop();
}
