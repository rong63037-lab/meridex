import type pg from "pg";
import type { Db } from "./db.js";
import { noteCandles } from "./feedStatus.js";
import { anchorFor, annualVol, refreshFeeds } from "./feeds.js";
import { loadCatalog, type Instrument } from "./instruments.js";
import { quietWarn, sleep } from "./net.js";

export const TIMEFRAMES = [
  { id: "1m", sec: 60, bars: 24 * 60, binance: "1m" },
  { id: "5m", sec: 300, bars: 12 * 24, binance: "5m" },
  { id: "15m", sec: 900, bars: 4 * 24 * 3, binance: "15m" },
  { id: "1H", sec: 3600, bars: 24 * 21, binance: "1h" },
  { id: "4H", sec: 14400, bars: 6 * 60, binance: "4h" },
  { id: "1D", sec: 86400, bars: 120, binance: "1d" },
] as const;

export type TfId = (typeof TIMEFRAMES)[number]["id"];

type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };

const BINANCE: Record<string, string> = {
  BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT", XRP: "XRPUSDT", BNB: "BNBUSDT", ADA: "ADAUSDT",
  DOGE: "DOGEUSDT", TRX: "TRXUSDT", AVAX: "AVAXUSDT", DOT: "DOTUSDT", LINK: "LINKUSDT", TON: "TONUSDT",
  LTC: "LTCUSDT", BCH: "BCHUSDT", POL: "POLUSDT", SHIB: "SHIBUSDT", NEAR: "NEARUSDT", ATOM: "ATOMUSDT",
  UNI: "UNIUSDT", XLM: "XLMUSDT", APT: "APTUSDT", ARB: "ARBUSDT", OP: "OPUSDT", FIL: "FILUSDT",
  ICP: "ICPUSDT", PAXG: "PAXGUSDT", XAUT: "XAUTUSDT",
};

function gauss(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function gbmBars(inst: Instrument, sec: number, count: number, endPx: number): Bar[] {
  const vol = annualVol(inst);
  const dt = sec / (365.25 * 24 * 3600);
  const n = count + 1;
  const start = endPx * Math.exp(-vol * Math.sqrt(count * dt) * 0.15);
  const path = [Math.max(1, start)];
  let px = path[0];
  for (let i = 1; i < n; i++) {
    px *= Math.exp((-0.5 * vol * vol) * dt + vol * Math.sqrt(dt) * gauss());
    path.push(Math.max(1, px));
  }
  const last = path[path.length - 1];
  const shift = Math.log(endPx / last);
  for (let i = 0; i < path.length; i++) {
    const w = n <= 1 ? 1 : i / (n - 1);
    path[i] = Math.max(1, path[i] * Math.exp(shift * w));
  }
  const endBucket = Math.floor(Date.now() / 1000 / sec) * sec;
  const bars: Bar[] = [];
  for (let i = 1; i < path.length; i++) {
    const open = path[i - 1];
    const close = path[i];
    const wick = Math.max(open, close) * vol * Math.sqrt(dt) * Math.abs(gauss()) * 0.55;
    const high = Math.max(open, close) + wick;
    const low = Math.max(1, Math.min(open, close) - wick);
    const time = endBucket - (count - i) * sec;
    const usd = (close / inst.priceScale);
    const notional = (inst.category === "crypto" ? 80_000 : 25_000) * (sec / 60) * (0.35 + Math.random());
    const qty = usd > 0 ? (notional / usd) * inst.qtyScale : inst.minQty;
    bars.push({ time, open, high, low, close, volume: Math.max(inst.minQty, qty) });
  }
  return bars;
}

function rescale(bars: Bar[], endPx: number): Bar[] {
  const last = bars[bars.length - 1]?.close;
  if (!last || !endPx) return bars;
  const factor = endPx / last;
  return bars.map((bar) => ({
    ...bar,
    open: bar.open * factor,
    high: bar.high * factor,
    low: bar.low * factor,
    close: bar.close * factor,
  }));
}

async function grab(url: string): Promise<unknown | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
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

async function grabRetry(url: string): Promise<unknown | null> {
  let last = "unavailable";
  for (let i = 0; i < 3; i++) {
    const body = await grab(url);
    if (body && !(Array.isArray(body) && body.length < 2)) {
      noteCandles("binance", null);
      return body;
    }
    last = "empty";
    if (i < 2) await sleep(200 * 2 ** i);
  }
  noteCandles("local", last);
  quietWarn("candles-binance", "candles binance unavailable, using local history");
  return null;
}

async function binanceBars(inst: Instrument, interval: string, limit: number): Promise<Bar[] | null> {
  const pair = BINANCE[inst.base];
  if (!pair) return null;
  const body = await grabRetry(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`);
  if (!Array.isArray(body) || body.length < 2) return null;
  const bars: Bar[] = [];
  for (const row of body as [number, string, string, string, string, string][]) {
    const open = Number(row[1]) * inst.priceScale;
    const high = Number(row[2]) * inst.priceScale;
    const low = Number(row[3]) * inst.priceScale;
    const close = Number(row[4]) * inst.priceScale;
    const volume = Number(row[5]) * inst.qtyScale;
    if (![open, high, low, close].every((n) => Number.isFinite(n) && n > 0)) continue;
    bars.push({ time: Math.floor(row[0] / 1000), open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
  }
  return bars.length >= 2 ? bars : null;
}

function ints(bar: Bar, inst: Instrument): { o: bigint; h: bigint; l: bigint; c: bigint; v: bigint; q: bigint } {
  const tick = BigInt(Math.max(1, inst.tickSize));
  const round = (n: number) => {
    const v = BigInt(Math.max(1, Math.round(n)));
    return (v / tick) * tick || tick;
  };
  let o = round(bar.open);
  let h = round(bar.high);
  let l = round(bar.low);
  let c = round(bar.close);
  const top = o > c ? o : c;
  const bot = o < c ? o : c;
  if (h < top) h = top;
  if (l > bot) l = bot;
  if (l < 1n) l = 1n;
  const qty = BigInt(Math.max(0, Math.round(bar.volume)));
  const quote = (c * qty * BigInt(inst.quoteScale)) / (BigInt(inst.qtyScale) * BigInt(inst.priceScale));
  return { o, h, l, c, v: qty, q: quote };
}

async function insertBars(client: pg.PoolClient, inst: Instrument, tf: string, bars: Bar[]): Promise<void> {
  const chunk = 200;
  for (let i = 0; i < bars.length; i += chunk) {
    const slice = bars.slice(i, i + chunk);
    const values: string[] = [];
    const params: (string | number)[] = [];
    slice.forEach((bar, idx) => {
      const row = ints(bar, inst);
      const base = idx * 9;
      values.push(`($${base + 1},$${base + 2},to_timestamp($${base + 3}),$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9})`);
      params.push(inst.symbol, tf, bar.time, row.o.toString(), row.h.toString(), row.l.toString(), row.c.toString(), row.v.toString(), row.q.toString());
    });
    await client.query(
      `INSERT INTO candles (symbol, tf, open_time, open_px, high_px, low_px, close_px, volume_qty, volume_quote)
       VALUES ${values.join(",")}
       ON CONFLICT (symbol, tf, open_time) DO NOTHING`,
      params,
    );
  }
}

/** Local GBM history so charts are full even when public klines are down. */
export async function backfillCandles(pool: Db): Promise<void> {
  await refreshFeeds().catch(() => undefined);
  const catalog = loadCatalog();
  let built = 0;
  for (const inst of catalog) {
    const have = await pool.query(
      `SELECT count(*)::int AS n,
              (array_agg(close_px ORDER BY open_time DESC))[1]::text AS last
       FROM candles WHERE symbol = $1 AND tf = '1D'`,
      [inst.symbol],
    );
    const endPx = anchorFor(inst);
    const haveN = Number(have.rows[0].n);
    const haveLast = Number(have.rows[0].last ?? 0);
    if (haveN >= 90 && haveLast > 0 && Math.abs(haveLast - endPx) / endPx < 0.01) continue;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM candles WHERE symbol = $1`, [inst.symbol]);
      for (const tf of TIMEFRAMES) {
        await insertBars(client, inst, tf.id, gbmBars(inst, tf.sec, tf.bars, endPx));
      }
      await client.query(
        `INSERT INTO candle_sources (symbol, source) VALUES ($1,'gbm')
         ON CONFLICT (symbol) DO UPDATE SET source = 'gbm', updated_at = now()`,
        [inst.symbol],
      );
      await client.query("COMMIT");
      built += 1;
    } catch (err) {
      await client.query("ROLLBACK");
      quietWarn("candles-write", `candles kept local history for ${inst.symbol}`);
    } finally {
      client.release();
    }
  }
  console.log(`candles backfill built=${built} source=gbm`);
}

/** Replace crypto GBM history with Binance klines when the public API answers. */
export async function enrichCryptoCandles(pool: Db): Promise<void> {
  const probe = loadCatalog().find((row) => row.symbol === "BTC/USD");
    if (!probe || !(await binanceBars(probe, "1d", 30))) {
    noteCandles("local", "binance unavailable");
    quietWarn("candles-binance", "candles binance unavailable, using local history");
    return;
  }
  const catalog = loadCatalog().filter((row) => row.category === "crypto" && BINANCE[row.base]);
  let upgraded = 0;
  for (const inst of catalog) {
    const marked = await pool.query(`SELECT source FROM candle_sources WHERE symbol = $1`, [inst.symbol]);
    if (marked.rows[0]?.source === "binance") continue;
    const endPx = anchorFor(inst);
    const fetched = await Promise.all(TIMEFRAMES.map(async (tf) => {
      const remote = await binanceBars(inst, tf.binance, Math.min(1000, tf.bars));
      const min = tf.id === "1D" ? 90 : 48;
      return remote && remote.length >= min ? { tf: tf.id, bars: rescale(remote, endPx) } : null;
    }));
    if (fetched.some((row) => !row)) continue;
    const collected = fetched.filter((row): row is { tf: TfId; bars: Bar[] } => row !== null);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM candles WHERE symbol = $1`, [inst.symbol]);
      for (const series of collected) await insertBars(client, inst, series.tf, series.bars);
      await client.query(
        `INSERT INTO candle_sources (symbol, source) VALUES ($1,'binance')
         ON CONFLICT (symbol) DO UPDATE SET source = 'binance', updated_at = now()`,
        [inst.symbol],
      );
      await client.query("COMMIT");
      upgraded += 1;
      console.log(`candles ${inst.symbol} source=binance`);
    } catch (err) {
      await client.query("ROLLBACK");
      noteCandles("local", "write failed");
      quietWarn("candles-binance", `candles kept local history for ${inst.symbol}`);
    } finally {
      client.release();
    }
  }
  console.log(`candles binance upgraded=${upgraded}`);
}

const TF_INDEX = new Map(TIMEFRAMES.map((tf) => [tf.id, tf]));

export type RawCandle = { time: number; open: string; high: string; low: string; close: string; volume: string };

/** First paint loads this many bars. Older bars come back with `before`. */
export const INITIAL_CANDLES = 300;
const CACHE_MS = 2000;
const packs = new Map<string, { at: number; bars: RawCandle[] }>();
const live = new Map<string, RawCandle>();

function ckey(symbol: string, tf: string): string {
  return `${symbol}|${tf}`;
}

function maxStr(a: string, b: string): string {
  return BigInt(a) > BigInt(b) ? a : b;
}

function minStr(a: string, b: string): string {
  return BigInt(a) < BigInt(b) ? a : b;
}

/** Update the open candle in memory. The HTTP cache and the websocket both read this. */
export function noteLive(symbol: string, price: bigint, qty: bigint): void {
  if (price <= 0n) return;
  const now = Math.floor(Date.now() / 1000);
  const px = price.toString();
  for (const tf of TIMEFRAMES) {
    const bucket = Math.floor(now / tf.sec) * tf.sec;
    const k = ckey(symbol, tf.id);
    const prev = live.get(k);
    let bar: RawCandle;
    if (prev && prev.time === bucket) {
      prev.high = maxStr(prev.high, px);
      prev.low = minStr(prev.low, px);
      prev.close = px;
      if (qty > 0n) prev.volume = (BigInt(prev.volume) + qty).toString();
      bar = prev;
    } else {
      bar = { time: bucket, open: px, high: px, low: px, close: px, volume: qty > 0n ? qty.toString() : "0" };
      live.set(k, bar);
    }
    const pack = packs.get(k);
    if (pack) {
      const last = pack.bars[pack.bars.length - 1];
      if (last && last.time === bar.time) pack.bars[pack.bars.length - 1] = { ...bar };
      else if (!last || last.time < bar.time) pack.bars.push({ ...bar });
      pack.at = Date.now();
    }
  }
}

export function liveOverlay(
  symbol: string,
  priceScale: number,
  qtyScale: number,
): Record<string, { time: number; open: number; high: number; low: number; close: number; volume: number }> {
  const out: Record<string, { time: number; open: number; high: number; low: number; close: number; volume: number }> = {};
  const ps = priceScale || 1;
  const qs = qtyScale || 1;
  for (const tf of TIMEFRAMES) {
    const bar = live.get(ckey(symbol, tf.id));
    if (!bar) continue;
    out[tf.id] = {
      time: bar.time,
      open: Number(bar.open) / ps,
      high: Number(bar.high) / ps,
      low: Number(bar.low) / ps,
      close: Number(bar.close) / ps,
      volume: Number(bar.volume) / qs,
    };
  }
  return out;
}

export async function noteCandle(
  client: pg.PoolClient,
  symbol: string,
  price: bigint,
  qty: bigint,
  quote: bigint,
): Promise<void> {
  if (price <= 0n || qty <= 0n) return;
  noteLive(symbol, price, qty);
  const now = Math.floor(Date.now() / 1000);
  for (const tf of TIMEFRAMES) {
    const bucket = Math.floor(now / tf.sec) * tf.sec;
    await client.query(
      `INSERT INTO candles (symbol, tf, open_time, open_px, high_px, low_px, close_px, volume_qty, volume_quote)
       VALUES ($1,$2,to_timestamp($3),$4,$4,$4,$4,$5,$6)
       ON CONFLICT (symbol, tf, open_time) DO UPDATE SET
         high_px = GREATEST(candles.high_px, EXCLUDED.high_px),
         low_px = LEAST(candles.low_px, EXCLUDED.low_px),
         close_px = EXCLUDED.close_px,
         volume_qty = candles.volume_qty + EXCLUDED.volume_qty,
         volume_quote = candles.volume_quote + EXCLUDED.volume_quote`,
      [symbol, tf.id, bucket, price.toString(), qty.toString(), quote.toString()],
    );
  }
}

export function isTf(value: string): value is TfId {
  return TF_INDEX.has(value as TfId);
}

export type DayStat = { open: number; high: number; low: number; last: number; volumeQuote: string; volumeQty: string };

export async function loadDayStats(pool: Db): Promise<Map<string, DayStat>> {
  const rows = await pool.query(
    `SELECT symbol,
            (array_agg(open_px ORDER BY open_time))[1]::text AS open,
            MAX(high_px)::text AS high,
            MIN(low_px)::text AS low,
            (array_agg(close_px ORDER BY open_time DESC))[1]::text AS last,
            COALESCE(SUM(volume_quote),0)::text AS volume_quote,
            COALESCE(SUM(volume_qty),0)::text AS volume_qty
     FROM candles
     WHERE tf = '1m' AND open_time >= now() - interval '24 hours'
     GROUP BY symbol`,
  );
  const out = new Map<string, DayStat>();
  for (const row of rows.rows) {
    out.set(row.symbol as string, {
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      last: Number(row.last),
      volumeQuote: row.volume_quote as string,
      volumeQty: row.volume_qty as string,
    });
  }
  return out;
}

export async function loadCandles(
  pool: Db,
  symbol: string,
  tf: TfId,
  opts?: { limit?: number; before?: number },
): Promise<{ bars: RawCandle[]; cache: "hit" | "miss" }> {
  const limit = Math.min(1500, Math.max(1, Math.floor(opts?.limit ?? INITIAL_CANDLES)));
  const before = opts?.before && Number.isFinite(opts.before) ? opts.before : null;
  const k = ckey(symbol, tf);
  if (before == null) {
    const hit = packs.get(k);
    if (hit && Date.now() - hit.at < CACHE_MS && hit.bars.length) {
      return { bars: hit.bars.slice(-limit), cache: "hit" };
    }
  }
  const rows = await pool.query(
    `SELECT EXTRACT(EPOCH FROM open_time)::bigint AS t, open_px::text, high_px::text, low_px::text, close_px::text, volume_qty::text
     FROM candles
     WHERE symbol = $1 AND tf = $2
       AND ($3::bigint IS NULL OR open_time < to_timestamp($3))
     ORDER BY open_time DESC
     LIMIT $4`,
    [symbol, tf, before, limit],
  );
  const bars: RawCandle[] = rows.rows.map((row) => ({
    time: Number(row.t),
    open: row.open_px as string,
    high: row.high_px as string,
    low: row.low_px as string,
    close: row.close_px as string,
    volume: row.volume_qty as string,
  })).reverse();
  if (before == null) {
    const cur = live.get(k);
    if (cur) {
      const last = bars[bars.length - 1];
      if (last && last.time === cur.time) {
        bars[bars.length - 1] = {
          ...last,
          high: maxStr(last.high, cur.high),
          low: minStr(last.low, cur.low),
          close: cur.close,
        };
      } else if (!last || last.time < cur.time) bars.push({ ...cur });
    }
    packs.set(k, { at: Date.now(), bars });
  }
  return { bars, cache: "miss" };
}
