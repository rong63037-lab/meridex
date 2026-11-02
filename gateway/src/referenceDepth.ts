import type { Db } from "./db.js";
import { PlatformError } from "./errors.js";
import { getInstrument, type Instrument } from "./instruments.js";
import { requireFreshTotp } from "./pool.js";

/**
 * Read-only public depth. GET only, no API key, no order path.
 * Binance, Coinbase, and Kraken are tried for a book. If those are
 * unreachable, CoinGecko, then the existing gold and FX price feeds.
 * A missing book is never invented.
 */

export type Level = { price: string; size: string };
export type PublicTrade = { price: string; size: string; side: "buy" | "sell"; time: string };
export type DepthKind = "book" | "price" | "none";
export type Grab = (url: string) => Promise<unknown | null>;

export type PublicDepth = {
  symbol: string;
  spot: string;
  source: string;
  kind: DepthKind;
  bids: Level[];
  asks: Level[];
  trades: PublicTrade[];
  price: string | null;
  unit: string;
  asOf: number;
};

type UrlSpec = { source: string; kind: "book" | "trades" | "price"; url: string };
type Snap = PublicDepth & { storedAt: number };

const HOSTS = new Set([
  "api.binance.com",
  "api.coinbase.com",
  "api.exchange.coinbase.com",
  "api.kraken.com",
  "api.coingecko.com",
  "api.gold-api.com",
  "api.frankfurter.app",
]);

const BINANCE: Record<string, string> = {
  BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT", XRP: "XRPUSDT", BNB: "BNBUSDT", ADA: "ADAUSDT",
  DOGE: "DOGEUSDT", TRX: "TRXUSDT", AVAX: "AVAXUSDT", DOT: "DOTUSDT", LINK: "LINKUSDT", TON: "TONUSDT",
  LTC: "LTCUSDT", BCH: "BCHUSDT", POL: "POLUSDT", SHIB: "SHIBUSDT", NEAR: "NEARUSDT", ATOM: "ATOMUSDT",
  UNI: "UNIUSDT", XLM: "XLMUSDT", APT: "APTUSDT", ARB: "ARBUSDT", OP: "OPUSDT", FIL: "FILUSDT",
  ICP: "ICPUSDT", PAXG: "PAXGUSDT",
};

const KRAKEN: Record<string, string> = {
  BTC: "XBTUSD", ETH: "ETHUSD", SOL: "SOLUSD", XRP: "XRPUSD", DOGE: "DOGEUSD", LTC: "LTCUSD",
  BCH: "BCHUSD", LINK: "LINKUSD", DOT: "DOTUSD", ATOM: "ATOMUSD", UNI: "UNIUSD", XLM: "XLMUSD",
  AVAX: "AVAXUSD", ADA: "ADAUSD", SHIB: "SHIBUSD", NEAR: "NEARUSD", FIL: "FILUSD", ICP: "ICPUSD",
  TON: "TONUSD", APT: "APTUSD", OP: "OPUSD", ARB: "ARBUSD", BNB: "BNBUSD", TRX: "TRXUSD", POL: "POLUSD",
  PAXG: "PAXGUSD",
};

const FX = new Set(["EUR", "GBP", "JPY", "AUD", "SGD", "MYR", "CNH", "HKD"]);
const METAL = new Set(["XAU", "XAG", "XPT", "XPD"]);
const OZ = 31.1034768;

const snaps = new Map<string, Snap>();

export function clearReferenceCache() {
  snaps.clear();
}

export function spotSymbol(symbol: string): string {
  const raw = symbol.trim().toUpperCase();
  if (raw.endsWith("-PERP")) return `${raw.slice(0, -5)}/USD`;
  return raw;
}

export function hostAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && HOSTS.has(parsed.host);
  } catch {
    return false;
  }
}

export function isStale(asOf: number, now: number, staleMs: number): boolean {
  if (!asOf) return false;
  return now - asOf > staleMs;
}

export function publicUrls(inst: Instrument): UrlSpec[] {
  const out: UrlSpec[] = [];
  if (inst.category === "crypto") {
    const binance = BINANCE[inst.base];
    if (binance) {
      out.push({ source: "binance", kind: "book", url: `https://api.binance.com/api/v3/depth?symbol=${binance}&limit=20` });
      out.push({ source: "binance", kind: "trades", url: `https://api.binance.com/api/v3/trades?symbol=${binance}&limit=12` });
    }
    out.push({ source: "coinbase", kind: "book", url: `https://api.coinbase.com/api/v3/brokerage/market/product_book?product_id=${inst.base}-USD&limit=10` });
    out.push({ source: "coinbase", kind: "trades", url: `https://api.exchange.coinbase.com/products/${inst.base}-USD/trades?limit=12` });
    const kraken = KRAKEN[inst.base];
    if (kraken) {
      out.push({ source: "kraken", kind: "book", url: `https://api.kraken.com/0/public/Depth?pair=${kraken}&count=20` });
      out.push({ source: "kraken", kind: "trades", url: `https://api.kraken.com/0/public/Trades?pair=${kraken}` });
    }
    if (inst.feed.startsWith("coingecko:")) {
      const id = encodeURIComponent(inst.feed.slice(10));
      out.push({ source: "coingecko", kind: "price", url: `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd` });
    }
  }
  if (inst.category === "metal" && inst.quote === "USD") {
    const code = inst.base.startsWith("XAU") ? "XAU" : inst.base;
    if (METAL.has(code)) out.push({ source: "gold-api", kind: "price", url: `https://api.gold-api.com/price/${code}` });
  }
  if (inst.category === "fx" && FX.has(inst.base)) {
    const code = inst.base === "CNH" ? "CNY" : inst.base;
    out.push({ source: "frankfurter", kind: "price", url: `https://api.frankfurter.app/latest?from=USD&to=${code}` });
  }
  return out;
}

function trimNumber(text: string): string {
  if (!text.includes(".")) return text;
  return text.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

export function cleanNumber(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return trimNumber(value.toFixed(8));
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return trimNumber(value.trim());
}

function pairLevels(raw: unknown): Level[] {
  if (!Array.isArray(raw)) return [];
  const out: Level[] = [];
  for (const item of raw) {
    if (!Array.isArray(item)) continue;
    const price = cleanNumber(item[0]);
    const size = cleanNumber(item[1]);
    if (!price || !size) continue;
    out.push({ price, size });
    if (out.length >= 10) break;
  }
  return out;
}

function objectLevels(raw: unknown): Level[] {
  if (!Array.isArray(raw)) return [];
  const out: Level[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as { price?: unknown; size?: unknown };
    const price = cleanNumber(row.price);
    const size = cleanNumber(row.size);
    if (!price || !size) continue;
    out.push({ price, size });
    if (out.length >= 10) break;
  }
  return out;
}

export function parseBinanceBook(body: unknown): { bids: Level[]; asks: Level[] } | null {
  const row = body as { bids?: unknown; asks?: unknown } | null;
  if (!row || !Array.isArray(row.bids) || !Array.isArray(row.asks)) return null;
  const bids = pairLevels(row.bids);
  const asks = pairLevels(row.asks);
  if (!bids.length && !asks.length) return null;
  return { bids, asks };
}

export function parseBinanceTrades(body: unknown): { trades: PublicTrade[]; asOf: number | null } {
  if (!Array.isArray(body)) return { trades: [], asOf: null };
  const trades: PublicTrade[] = [];
  let asOf: number | null = null;
  for (const item of body) {
    if (!item || typeof item !== "object") continue;
    const row = item as { price?: unknown; qty?: unknown; time?: unknown; isBuyerMaker?: boolean };
    const price = cleanNumber(row.price);
    const size = cleanNumber(row.qty);
    if (!price || !size) continue;
    const ms = Number(row.time);
    if (Number.isFinite(ms)) asOf = asOf == null ? ms : Math.max(asOf, ms);
    trades.push({
      price,
      size,
      side: row.isBuyerMaker ? "sell" : "buy",
      time: Number.isFinite(ms) ? new Date(ms).toISOString() : "",
    });
    if (trades.length >= 8) break;
  }
  return { trades, asOf };
}

export function parseCoinbaseBook(body: unknown): { bids: Level[]; asks: Level[]; asOf: number | null } | null {
  const book = (body as { pricebook?: { bids?: unknown; asks?: unknown; time?: string } } | null)?.pricebook;
  if (!book) return null;
  const bids = objectLevels(book.bids);
  const asks = objectLevels(book.asks);
  if (!bids.length && !asks.length) return null;
  const ms = book.time ? Date.parse(book.time) : NaN;
  return { bids, asks, asOf: Number.isFinite(ms) ? ms : null };
}

export function parseCoinbaseTrades(body: unknown): { trades: PublicTrade[]; asOf: number | null } {
  if (!Array.isArray(body)) return { trades: [], asOf: null };
  const trades: PublicTrade[] = [];
  let asOf: number | null = null;
  for (const item of body) {
    if (!item || typeof item !== "object") continue;
    const row = item as { price?: unknown; size?: unknown; side?: string; time?: string };
    const price = cleanNumber(row.price);
    const size = cleanNumber(row.size);
    if (!price || !size) continue;
    const ms = row.time ? Date.parse(row.time) : NaN;
    if (Number.isFinite(ms)) asOf = asOf == null ? ms : Math.max(asOf, ms);
    trades.push({
      price,
      size,
      side: row.side === "sell" ? "sell" : "buy",
      time: Number.isFinite(ms) ? new Date(ms).toISOString() : "",
    });
    if (trades.length >= 8) break;
  }
  return { trades, asOf };
}

export function parseKrakenBook(body: unknown): { bids: Level[]; asks: Level[]; asOf: number | null } | null {
  const result = (body as { result?: Record<string, { bids?: unknown; asks?: unknown }> } | null)?.result;
  if (!result) return null;
  const first = Object.values(result)[0];
  if (!first || Array.isArray(first)) return null;
  const bids = pairLevels(first.bids);
  const asks = pairLevels(first.asks);
  if (!bids.length && !asks.length) return null;
  let asOf: number | null = null;
  for (const side of [first.bids, first.asks]) {
    if (!Array.isArray(side)) continue;
    for (const item of side) {
      if (!Array.isArray(item)) continue;
      const sec = Number(item[2]);
      if (!Number.isFinite(sec)) continue;
      const ms = sec > 10_000_000_000 ? sec : sec * 1000;
      asOf = asOf == null ? ms : Math.max(asOf, ms);
    }
  }
  return { bids, asks, asOf };
}

export function parseKrakenTrades(body: unknown): { trades: PublicTrade[]; asOf: number | null } {
  const result = (body as { result?: Record<string, unknown> } | null)?.result;
  if (!result) return { trades: [], asOf: null };
  const trades: PublicTrade[] = [];
  let asOf: number | null = null;
  for (const value of Object.values(result)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (!Array.isArray(item)) continue;
      const price = cleanNumber(item[0]);
      const size = cleanNumber(item[1]);
      if (!price || !size) continue;
      const sec = Number(item[2]);
      const ms = Number.isFinite(sec) ? sec * 1000 : NaN;
      if (Number.isFinite(ms)) asOf = asOf == null ? ms : Math.max(asOf, ms);
      const side = item[3] === "s" ? "sell" : "buy";
      trades.push({ price, size, side, time: Number.isFinite(ms) ? new Date(ms).toISOString() : "" });
      if (trades.length >= 8) break;
    }
  }
  return { trades, asOf };
}

export function parseGeckoPrice(body: unknown, id: string): string | null {
  const row = body as Record<string, { usd?: unknown }> | null;
  return cleanNumber(row?.[id]?.usd);
}

export function parseGoldPrice(body: unknown): string | null {
  return cleanNumber((body as { price?: unknown } | null)?.price);
}

export function parseFrankfurter(body: unknown, code: string): string | null {
  const rate = (body as { rates?: Record<string, number> } | null)?.rates?.[code];
  if (!rate || rate <= 0) return null;
  return cleanNumber(1 / rate);
}

function metalQuote(symbol: string, ounce: string): { price: string; unit: string } {
  const n = Number(ounce);
  if (symbol === "XAUKG/USD") return { price: trimNumber((n * (1000 / OZ)).toFixed(2)), unit: "kg" };
  return { price: trimNumber(n.toFixed(2)), unit: "oz" };
}

function empty(inst: Instrument, now: number): PublicDepth {
  return {
    symbol: inst.symbol,
    spot: inst.symbol,
    source: "none",
    kind: "none",
    bids: [],
    asks: [],
    trades: [],
    price: null,
    unit: inst.base,
    asOf: now,
  };
}

export async function readPublicDepth(inst: Instrument, grab: Grab, now = Date.now()): Promise<PublicDepth> {
  const urls = publicUrls(inst);
  const loaded = await Promise.all(urls.map(async (row) => ({ ...row, body: await grab(row.url) })));
  const bodyOf = (source: string, kind: UrlSpec["kind"]) => loaded.find((row) => row.source === source && row.kind === kind)?.body;
  const geckoId = inst.feed.startsWith("coingecko:") ? inst.feed.slice(10) : "";

  for (const source of ["binance", "coinbase", "kraken"] as const) {
    const book = source === "binance"
      ? parseBinanceBook(bodyOf(source, "book"))
      : source === "coinbase"
        ? parseCoinbaseBook(bodyOf(source, "book"))
        : parseKrakenBook(bodyOf(source, "book"));
    if (!book || (!book.bids.length && !book.asks.length)) continue;
    const prints = source === "binance"
      ? parseBinanceTrades(bodyOf(source, "trades"))
      : source === "coinbase"
        ? parseCoinbaseTrades(bodyOf(source, "trades"))
        : parseKrakenTrades(bodyOf(source, "trades"));
    const bookAsOf = "asOf" in book && typeof book.asOf === "number" ? book.asOf : null;
    const asOf = bookAsOf || prints.asOf || now;
    const top = book.bids[0]?.price ?? book.asks[0]?.price ?? null;
    return {
      symbol: inst.symbol,
      spot: inst.symbol,
      source,
      kind: "book",
      bids: book.bids,
      asks: book.asks,
      trades: prints.trades,
      price: top,
      unit: inst.base,
      asOf,
    };
  }

  if (geckoId) {
    const price = parseGeckoPrice(bodyOf("coingecko", "price"), geckoId);
    if (price) {
      return { ...empty(inst, now), source: "coingecko", kind: "price", price, unit: inst.base, asOf: now };
    }
  }
  const ounce = parseGoldPrice(bodyOf("gold-api", "price"));
  if (ounce) {
    const quote = metalQuote(inst.symbol, ounce);
    return { ...empty(inst, now), source: "gold-api", kind: "price", price: quote.price, unit: quote.unit, asOf: now };
  }
  const fxCode = inst.base === "CNH" ? "CNY" : inst.base;
  const fx = parseFrankfurter(bodyOf("frankfurter", "price"), fxCode);
  if (fx) {
    return { ...empty(inst, now), source: "frankfurter", kind: "price", price: fx, unit: inst.base, asOf: now };
  }
  return empty(inst, now);
}

export async function publicGet(url: string): Promise<unknown | null> {
  if (!hostAllowed(url)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: ctrl.signal,
      headers: { accept: "application/json", "user-agent": "meridex-sandbox/1.0" },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function settings(pool: Db) {
  const row = await pool.query(`SELECT enabled, stale_ms FROM reference_depth WHERE id = 1`);
  return {
    enabled: Boolean(row.rows[0]?.enabled),
    staleMs: Number(row.rows[0]?.stale_ms ?? 4000),
  };
}

export async function referenceAdmin(pool: Db) {
  const cfg = await settings(pool);
  const audit = await pool.query(
    `SELECT id, actor_email, previous, next, created_at
     FROM reference_depth_audit ORDER BY id DESC LIMIT 8`,
  );
  return { enabled: cfg.enabled, staleMs: cfg.staleMs, audit: audit.rows };
}

export async function setReference(
  pool: Db,
  actor: { id: number; email: string },
  input: { enabled: boolean; totp?: string },
) {
  await requireFreshTotp(pool, actor.id, input.totp);
  const owner = await pool.query(`SELECT address_pool_owner FROM users WHERE id = $1`, [actor.id]);
  if (!owner.rows[0]?.address_pool_owner) throw new PlatformError("FORBIDDEN", 403);
  const previous = await settings(pool);
  await pool.query(`UPDATE reference_depth SET enabled = $1, updated_at = now() WHERE id = 1`, [input.enabled]);
  await pool.query(
    `INSERT INTO reference_depth_audit (actor_user_id, actor_email, previous, next)
     VALUES ($1,$2,$3::jsonb,$4::jsonb)`,
    [actor.id, actor.email, JSON.stringify({ enabled: previous.enabled }), JSON.stringify({ enabled: input.enabled })],
  );
  clearReferenceCache();
  return referenceAdmin(pool);
}

export async function referenceView(pool: Db, symbol: string, grab: Grab = publicGet) {
  const spot = spotSymbol(symbol);
  let inst: Instrument;
  try {
    inst = getInstrument(spot);
  } catch {
    throw new PlatformError("UNKNOWN_SYMBOL", 400);
  }
  const cfg = await settings(pool);
  const asked = symbol.trim().toUpperCase();
  if (!cfg.enabled) return { enabled: false, symbol: asked };
  const now = Date.now();
  let snap = snaps.get(spot);
  if (!snap || now - snap.storedAt > 1500) {
    const fresh = await readPublicDepth(inst, grab, now);
    snap = { ...fresh, symbol: asked, spot, storedAt: Date.now() };
    snaps.set(spot, snap);
  }
  const asOf = snap.asOf || snap.storedAt;
  return {
    enabled: true,
    symbol: asked,
    spot,
    source: snap.source,
    kind: snap.kind,
    bids: snap.bids,
    asks: snap.asks,
    trades: snap.trades,
    price: snap.price,
    unit: snap.unit,
    asOf,
    staleAfterMs: cfg.staleMs,
    stale: isStale(asOf, Date.now(), cfg.staleMs),
  };
}
