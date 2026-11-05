import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import QRCode from "qrcode";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { generateTotpSecret, hashPassword, signJwt, verifyJwt, verifyPassword, verifyTotp } from "./crypto.js";
import { createPool, migrate, withTx, type Db } from "./db.js";
import type { EngineClient } from "./engineClient.js";
import { clientIp, lookupCountry } from "./geo.js";
import { canTrade, decideKyc, isSourceBlocked, type Policy } from "./kyc.js";
import { decideKycReview, logDenied as logKycDenied } from "./kycReview.js";
import { adminCatalog, ensureCoverage, isLocked, knownPlace, offeredTo, placeOf, publicCatalog } from "./coverage.js";
import { entityFor, loadPolicy } from "./policy.js";
import { ModeError, assertMode } from "./modes.js";
import { registerModeRoutes } from "./modeRoutes.js";
import { registerPlatformRoutes } from "./platformRoutes.js";
import { bindLiquidityPool, startMarkLoop } from "./liquidity/mark.js";
import { registerContentRoutes } from "./contentRoutes.js";
import { adjustUsdMove, redemptionCatalog } from "./content.js";
import {
  PlatformError,
  accrueCommission,
  assertNotFrozen,
  assertPassword,
  assertWhitelist,
  ingestSafe,
  pulseDemoAlert,
  requireStepUp,
  scopeOk,
  seedPlatform,
  verifySigned,
} from "./platform.js";
import { startRecurringLoop } from "./recurring.js";
import { checkInvariants, deposit, ensureCustomer, LedgerError, withdraw, type CustomerRef } from "./ledger.js";
import { enqueueWithdrawal, noteAutoWithdraw, reviewRequired } from "./withdrawals.js";
import { categoryAccess, ensureInstruments, getInstrument, loadCatalog, type Instrument } from "./instruments.js";
import { addWatch, createAlert, deleteAlert, listAlerts, listNotices, listWatch, markNoticesRead, removeWatch, startAlertLoop } from "./alerts.js";
import { backfillCandles, enrichCryptoCandles, isTf, liveOverlay, loadCandles, loadDayStats, noteLive, TIMEFRAMES } from "./candles.js";
import { globalView, globalVolumeBars, startGlobalLoop } from "./global.js";
import { sourceFor } from "./feeds.js";
import { referenceView } from "./referenceDepth.js";
import { feedReport } from "./feedStatus.js";
import { ensureFloats, primeBooks, startMakers } from "./makers.js";
import { loadBot, seedDemo, startBots } from "./seed.js";
import { depositInstructions, listDeposits, onDepositCredited } from "./concierge.js";
import { createClaim, listClaims } from "./manualDeposits.js";
import { amendOrder, cancelAll, cancelOrder, loadCustomer, placeOrder, recoverPending, repairUnsettledTrades, scanTriggers } from "./trading.js";
import {
  PaperReject,
  cancelAllPaper,
  cancelPaperOrder,
  listPaperOrders,
  listPaperTrades,
  paperView,
  placePaperOrder,
  portfolioView,
  resetPaper,
  setPaperEnabled,
} from "./paper.js";
import { parseScaled } from "./units.js";
import {
  assertRealRails,
  cancelAllPlay,
  cancelPlayOrder,
  isInternalTest,
  listPlayOrders,
  listPlayTrades,
  placePlayOrder,
  playBalances,
  sweepPlay,
} from "./play.js";
import {
  advanceWorkflows,
  createApiKey,
  createRail,
  createRedemption,
  getPrefs,
  listApiKeys,
  listLogins,
  listRails,
  listRedemptions,
  listSessions,
  recordLogin,
  revokeApiKey,
  revokeSession,
  savePrefs,
  touchSession,
  createCrypto,
  listCrypto,
} from "./workflows.js";

type Authed = { id: number; email: string; role: string };

const buckets = new Map<string, { tokens: number; updated: number }>();

function allow(key: string, rate: number, burst: number): boolean {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: burst, updated: now };
    buckets.set(key, bucket);
  }
  const elapsed = (now - bucket.updated) / 1000;
  bucket.tokens = Math.min(burst, bucket.tokens + elapsed * rate);
  bucket.updated = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

function paperFail(reply: FastifyReply, err: unknown) {
  if (err instanceof PaperReject) {
    const status = err.code === "NOT_FOUND" ? 404 : err.code === "VALIDATION" || err.code === "UNKNOWN_SYMBOL" ? 400 : err.code === "MARKET_HALTED" ? 403 : 409;
    return reply.code(status).send({ error: err.code, rejectReason: err.code });
  }
  return fail(reply, err);
}

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof PlatformError) return reply.code(err.status).send({ error: err.code });
  if (err instanceof LedgerError || err instanceof Error && err.message === "VALIDATION") {
    const code = err instanceof LedgerError ? err.code : "VALIDATION";
    const status =
      code === "NOT_FOUND"
        ? 404
        : code === "PRICE_BAND"
          ? 409
          : code === "MARKET_HALTED" || code === "GEO_BLOCKED" || code === "SESSION_REVOKED" || code === "CATEGORY_PENDING" || code === "CATEGORY_BLOCKED"
            ? 403
            : code === "LP_KILLED" || code === "LP_REJECTED" || code === "LP_RESTING" || code === "LP_CAP" || code === "LP_DOCS_REQUIRED"
              ? 409
              : 400;
    return reply.code(status).send({ error: code });
  }
  console.error(err);
  return reply.code(500).send({ error: "INTERNAL" });
}

export function mapBook(raw: {
  symbol: string;
  reference_price: number;
  last_trade_price: number | null;
  halted: boolean;
  band_low: number;
  band_high: number;
  halt_low: number;
  halt_high: number;
  bids: { price: number; qty: number; orders: number }[];
  asks: { price: number; qty: number; orders: number }[];
  state_hash: string;
  trade_count: number;
}, inst?: Instrument) {
  return {
    symbol: raw.symbol,
    referencePrice: raw.reference_price,
    lastPrice: raw.last_trade_price,
    halted: raw.halted,
    bandLow: raw.band_low,
    bandHigh: raw.band_high,
    haltLow: raw.halt_low,
    haltHigh: raw.halt_high,
    bids: raw.bids,
    asks: raw.asks,
    stateHash: raw.state_hash,
    tradeCount: raw.trade_count,
    priceUnit: inst ? "price_units" : "usd_cents_per_gram",
    qtyUnit: inst ? "qty_units" : "mg",
    priceScale: inst?.priceScale ?? 100,
    qtyScale: inst?.qtyScale ?? 1000,
    quoteScale: inst?.quoteScale ?? 1_000_000,
    priceDecimals: inst?.priceDecimals ?? 2,
    qtyDecimals: inst?.qtyDecimals ?? 3,
    tickSize: inst?.tickSize ?? 1,
    base: inst?.base ?? "XAU",
    quote: inst?.quote ?? "USD",
    category: inst?.category ?? "metal",
    indicative: true,
  };
}

type Client = { ws: WebSocket; userId: number | null; symbol: string; tf: string };

export async function buildServer(pool: Db, engine: EngineClient, jwtSecret: string) {
  let policy = await loadPolicy(pool);
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  const adminAllow = (process.env.ADMIN_IP_ALLOWLIST ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  await app.register(cors, { origin: true });
  app.addHook("onRequest", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    const path = (req.url || "/").split("?")[0];
    if (path.startsWith("/api/admin") && adminAllow.length) {
      const ip = clientIp(req).replace(/^::ffff:/, "");
      if (!adminAllow.includes(ip)) {
        return reply.code(403).send({ error: "ADMIN_IP_DENIED" });
      }
    }
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
    const origin = req.headers.origin;
    if (!origin) return;
    try {
      const host = new URL(origin).hostname;
      if (host !== "localhost" && host !== "127.0.0.1") {
        return reply.code(403).send({ error: "CSRF_ORIGIN" });
      }
    } catch {
      return reply.code(403).send({ error: "CSRF_ORIGIN" });
    }
  });
  const clients = new Set<Client>();

  let bookLock = false;
  let bookAgain = false;
  async function broadcastBook() {
    if (bookLock) {
      bookAgain = true;
      return;
    }
    bookLock = true;
    try {
      do {
        bookAgain = false;
        await sendSnapshot();
        await pushRecentExecutions();
      } while (bookAgain);
    } catch (err) {
      console.error("broadcast", err);
    } finally {
      bookLock = false;
    }
  }

  async function sendSnapshot() {
    const wanted = new Set<string>(["XAU/USD"]);
    for (const client of clients) wanted.add(client.symbol || "XAU/USD");
    let primary = mapBook(await engine.book(), getInstrument("XAU/USD"));
    for (const symbol of wanted) {
      let inst: Instrument;
      try {
        inst = getInstrument(symbol);
      } catch {
        continue;
      }
      const tEngine = Date.now();
      const raw = symbol === "XAU/USD" ? await engine.book() : await engine.book(symbol);
      const engineMs = Date.now() - tEngine;
      const book = mapBook(raw, inst);
      if (symbol === "XAU/USD") primary = book;
      if (book.lastPrice != null && book.lastPrice > 0) noteLive(symbol, BigInt(Math.round(book.lastPrice)), 0n);
      const trades = await recentTrades(pool, 40, symbol);
      const candles = liveOverlay(symbol, inst.priceScale, inst.qtyScale);
      const payload = JSON.stringify({ type: "book", book, trades, chart: [], candles, sentAt: Date.now(), engineMs });
      for (const client of clients) {
        if ((client.symbol || "XAU/USD") === symbol && client.ws.readyState === 1) client.ws.send(payload);
      }
      const fired = await scanTriggers(pool, engine, symbol, book.lastPrice, book.halted);
      if (fired) {
        const again = mapBook(await engine.book(symbol), inst);
        if (again.lastPrice != null && again.lastPrice > 0) noteLive(symbol, BigInt(Math.round(again.lastPrice)), 0n);
        const payload2 = JSON.stringify({
          type: "book",
          book: again,
          trades: await recentTrades(pool, 40, symbol),
          chart: [],
          candles: liveOverlay(symbol, inst.priceScale, inst.qtyScale),
          sentAt: Date.now(),
          engineMs,
        });
        for (const client of clients) {
          if ((client.symbol || "XAU/USD") === symbol && client.ws.readyState === 1) client.ws.send(payload2);
        }
      }
    }
    return primary;
  }

  async function pushRecentExecutions() {
    const rows = await pool.query(
      `SELECT engine_trade_id, price_cents, qty_mg, buyer_id, seller_id, taker_side, symbol
       FROM trades WHERE tape_at > now() - interval '4 seconds' ORDER BY tape_at DESC LIMIT 40`,
    );
    const touched = new Set<number>();
    for (const row of rows.rows) {
      for (const id of [Number(row.buyer_id), Number(row.seller_id)]) {
        if (!clientsHas(id)) continue;
        touched.add(id);
        const side = Number(row.buyer_id) === id ? "buy" : "sell";
        const payload = JSON.stringify({
          type: "execution",
          tradeId: row.engine_trade_id,
          side,
          price: Number(row.price_cents),
          qty: Number(row.qty_mg),
          symbol: row.symbol,
          status: "filled",
        });
        for (const client of clients) {
          if (client.userId === id && client.ws.readyState === 1) client.ws.send(payload);
        }
      }
    }
    for (const id of touched) await pushUser(id);
  }

  function clientsHas(userId: number): boolean {
    for (const client of clients) if (client.userId === userId) return true;
    return false;
  }

  async function pushUser(userId: number) {
    const balances = await balancesFor(pool, userId);
    const payload = JSON.stringify({ type: "balances", balances });
    for (const client of clients) {
      if (client.userId === userId && client.ws.readyState === 1) client.ws.send(payload);
    }
  }

  function readCookie(req: FastifyRequest, name: string): string | null {
    const raw = req.headers.cookie;
    if (!raw) return null;
    for (const part of raw.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() !== name) continue;
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return part.slice(eq + 1).trim();
      }
    }
    return null;
  }

  function portalFor(req: FastifyRequest): "customer" | "staff" | "pool" {
    const path = (req.url || "/").split("?")[0];
    if (path.startsWith("/api/pool")) return "pool";
    return path.startsWith("/api/admin") ? "staff" : "customer";
  }

  function portalError(expected: "customer" | "staff" | "pool", got?: string): string {
    if (expected === "pool" || got === "pool") return "POOL_DESK";
    return expected === "staff" ? "CUSTOMER_SESSION" : "STAFF_SESSION";
  }

  async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<Authed | null> {
    const portal = portalFor(req);
    const cookieName = portal === "staff" ? "meridex_staff" : portal === "pool" ? "meridex_pool" : "meridex_customer";
    const header = req.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null;
    const cookie = readCookie(req, cookieName);
    const other = (["meridex_staff", "meridex_customer", "meridex_pool"] as const).some(
      (name) => name !== cookieName && readCookie(req, name),
    );
    const token = bearer || cookie;
    if (!token) {
      if (other) {
        reply.code(403).send({ error: portalError(portal) });
        return null;
      }
      reply.code(401).send({ error: "MFA_REQUIRED" });
      return null;
    }
    const payload = verifyJwt(token, jwtSecret);
    if (!payload) {
      reply.code(401).send({ error: "MFA_REQUIRED" });
      return null;
    }
    if (payload.portal !== portal) {
      reply.code(403).send({ error: portalError(portal, payload.portal) });
      return null;
    }
    if (payload.sid) {
      const live = await touchSession(pool, payload.sid);
      if (!live) {
        reply.code(403).send({ error: "SESSION_REVOKED" });
        return null;
      }
    }
    return { id: Number(payload.sub), email: payload.email, role: payload.role };
  }

  app.get("/healthz", async () => {
    const book = await engine.health();
    await pool.query("SELECT 1");
    return { ok: true, engine: book.state_hash, halted: book.halted, feeds: feedReport() };
  });

  app.get("/api/market/book", async (req) => {
    const symbol = ((req.query as { symbol?: string }).symbol || "XAU/USD").toUpperCase();
    return mapBook(await engine.book(symbol), getInstrument(symbol));
  });

  app.get("/api/market/reference", async (req, reply) => {
    const symbol = String((req.query as { symbol?: string }).symbol || "XAU/USD");
    try {
      const body = await referenceView(pool, symbol);
      reply.header("cache-control", body.enabled ? "public, max-age=1" : "no-store");
      return body;
    } catch (err) {
      if (err instanceof PlatformError) return reply.code(err.status).send({ error: err.code });
      throw err;
    }
  });

  app.get("/api/market/trades", async (req) => {
    const symbol = ((req.query as { symbol?: string }).symbol || "XAU/USD").toUpperCase();
    return recentTrades(pool, 120, symbol);
  });

  app.get("/api/market/summary", async () => {
    const book = mapBook(await engine.book());
    const bid = book.bids[0]?.price ?? null;
    const ask = book.asks[0]?.price ?? null;
    return {
      ...book,
      bid,
      ask,
      spread: bid !== null && ask !== null ? ask - bid : null,
    };
  });

  app.get("/api/market/instruments", async (_req, reply) => {
    reply.header("cache-control", "public, max-age=30");
    const rows = await pool.query(
      `SELECT symbol, name_zh, name_en, category, base_asset, quote_asset, tick_size::text, lot_size::text, min_qty::text,
              qty_scale::text, price_scale::text, price_decimals, qty_decimals, quote_scale::text,
              band_bps, halt_bps, ref_price::text, status, jurisdictions, regulatory_tag, feed, networks
       FROM instruments ORDER BY category, symbol`,
    );
    return { count: rows.rowCount, instruments: rows.rows };
  });

  app.get("/api/market/candles", async (req, reply) => {
    const q = req.query as { symbol?: string; tf?: string; limit?: string; before?: string };
    const symbol = (q.symbol || "XAU/USD").toUpperCase();
    const tf = (q.tf || "1m").trim();
    if (!isTf(tf)) return reply.code(400).send({ error: "BAD_TIMEFRAME" });
    let inst: Instrument;
    try {
      inst = getInstrument(symbol);
    } catch {
      return reply.code(400).send({ error: "UNKNOWN_SYMBOL" });
    }
    const limitRaw = Number(q.limit ?? 300);
    const limit = Number.isFinite(limitRaw) ? Math.min(1500, Math.max(1, Math.floor(limitRaw))) : 300;
    const beforeRaw = q.before ? Number(q.before) : NaN;
    const before = Number.isFinite(beforeRaw) ? beforeRaw : undefined;
    reply.header("cache-control", before ? "public, max-age=60" : "public, max-age=1, stale-while-revalidate=5");
    const loaded = await loadCandles(pool, symbol, tf, { limit, before });
    reply.header("x-candle-cache", loaded.cache);
    const rows = loaded.bars;
    const ps = inst.priceScale;
    const qs = inst.qtyScale;
    const candles = rows.map((row) => ({
      time: row.time,
      open: Number(row.open) / ps,
      high: Number(row.high) / ps,
      low: Number(row.low) / ps,
      close: Number(row.close) / ps,
      volume: Number(row.volume) / qs,
    }));
    const stat = (await loadDayStats(pool)).get(symbol);
    const lastUnits = stat?.last ?? inst.refPrice;
    const openUnits = stat?.open || lastUnits;
    return {
      symbol,
      tf,
      source: sourceFor(symbol),
      global: globalView(symbol),
      candles,
      serverTs: Date.now(),
      limit,
      more: rows.length >= limit,
      stats: {
        open: openUnits / ps,
        high: (stat?.high ?? lastUnits) / ps,
        low: (stat?.low ?? lastUnits) / ps,
        last: lastUnits / ps,
        change: openUnits ? (lastUnits - openUnits) / openUnits : 0,
        volume: Number(stat?.volumeQty ?? "0") / qs,
      },
    };
  });

  app.get("/api/market/volume", async (req, reply) => {
    const q = req.query as { symbol?: string; tf?: string; scope?: string };
    const symbol = (q.symbol || "XAU/USD").toUpperCase();
    const tf = (q.tf || "1m").trim();
    if (!isTf(tf)) return reply.code(400).send({ error: "BAD_TIMEFRAME" });
    let inst: Instrument;
    try {
      inst = getInstrument(symbol);
    } catch {
      return reply.code(400).send({ error: "UNKNOWN_SYMBOL" });
    }
    const scope = q.scope === "global" ? "global" : "venue";
    if (scope === "venue") {
      const spec = TIMEFRAMES.find((row) => row.id === tf)!;
      const from = Math.floor(Date.now() / 1000) - spec.sec * spec.bars;
      const rows = await pool.query(
        `SELECT (FLOOR(EXTRACT(EPOCH FROM tape_at) / $2) * $2)::bigint AS t, COALESCE(SUM(qty_mg),0)::text AS qty
         FROM trades WHERE symbol = $1 AND tape_at >= to_timestamp($3) GROUP BY 1 ORDER BY 1`,
        [symbol, spec.sec, from],
      );
      return {
        scope,
        source: "MERIDEX",
        delayed: false,
        note: "This venue's fills",
        bars: rows.rows.map((row) => ({ time: Number(row.t), volume: Number(row.qty) / inst.qtyScale })),
      };
    }
    const bars = await globalVolumeBars(symbol, tf);
    const ref = globalView(symbol);
    return { scope, source: ref.source, delayed: ref.delayed, note: ref.note, bars: bars ?? [] };
  });

  let tickerMemo: { at: number; body: unknown } | null = null;
  app.get("/api/market/tickers", async (_req, reply) => {
    reply.header("cache-control", "public, max-age=2");
    if (tickerMemo && Date.now() - tickerMemo.at < 1000) return tickerMemo.body;
    const summaries = await engine.summaries();
    const bySymbol = new Map(summaries.books.map((row) => [row.symbol, row]));
    const day = await loadDayStats(pool);
    const venue = await pool.query(
      `SELECT symbol, COALESCE(SUM(notional_uusd),0)::text AS usd, COALESCE(SUM(qty_mg),0)::text AS qty
       FROM trades WHERE tape_at > now() - interval '24 hours' GROUP BY symbol`,
    );
    const venueMap = new Map(venue.rows.map((row) => [row.symbol as string, { usd: row.usd as string, qty: row.qty as string }]));
    const recent = await pool.query(
      `SELECT symbol, count(*)::int AS n, COALESCE(SUM(notional_uusd),0)::text AS vol
       FROM trades WHERE tape_at > now() - interval '20 minutes' GROUP BY symbol`,
    );
    const recentMap = new Map(recent.rows.map((row) => [row.symbol as string, { n: Number(row.n), vol: row.vol as string }]));
    const body = loadCatalog().map((inst) => {
      const live = bySymbol.get(inst.symbol);
      const stat = day.get(inst.symbol);
      const tape = recentMap.get(inst.symbol);
      const thin = !tape || tape.n < 2 || BigInt(tape.vol) < 1_000_000_000n;
      const ref = live?.reference_price ?? inst.refPrice;
      let last = live?.last_trade_price ?? stat?.last ?? ref;
      if (live?.last_trade_price != null && ref > 0 && Math.abs(live.last_trade_price - ref) / ref > 0.2) {
        last = stat?.last != null && Math.abs(stat.last - ref) / ref < 0.2 ? stat.last : ref;
      }
      const open = stat?.open || last;
      const filled = venueMap.get(inst.symbol);
      const venueUsd = Number(filled?.usd ?? "0") / 1_000_000;
      const venueBase = Number(filled?.qty ?? "0") / inst.qtyScale;
      const quote = globalView(inst.symbol);
      const ps = inst.priceScale || 1;
      let high: number | null = null;
      let low: number | null = null;
      let rangeSource: "venue" | "reference" | null = null;
      if (stat && stat.high > 0 && stat.low > 0) {
        high = stat.high / ps;
        low = stat.low / ps;
        rangeSource = "venue";
      } else if (quote.high != null && quote.low != null && quote.high > 0 && quote.low > 0) {
        high = quote.high;
        low = quote.low;
        rangeSource = "reference";
      }
      return {
        symbol: inst.symbol,
        nameZh: inst.nameZh,
        nameEn: inst.nameEn,
        category: inst.category,
        base: inst.base,
        quote: inst.quote,
        last,
        reference: live?.reference_price ?? inst.refPrice,
        change: open ? (last - open) / open : 0,
        volume: filled?.usd ?? "0",
        volumeQty: filled?.qty ?? "0",
        venueVolumeUsd: venueUsd,
        venueVolumeBase: venueBase,
        high,
        low,
        rangeSource,
        global: quote,
        halted: live?.halted ?? false,
        liquidity: thin ? "low" : "ok",
        recentTrades: tape?.n ?? 0,
        status: inst.status,
        priceScale: inst.priceScale,
        qtyScale: inst.qtyScale,
        priceDecimals: inst.priceDecimals,
        qtyDecimals: inst.qtyDecimals,
        regulatoryTag: inst.regulatoryTag,
        feed: sourceFor(inst.symbol) ?? inst.feed,
        indicative: true,
      };
    });
    tickerMemo = { at: Date.now(), body };
    return body;
  });

  app.get("/api/market/access", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const customer = await loadCustomer(pool, user.id);
    if (!customer) return { residence: null, categories: {} };
    const categories: Record<string, string> = {};
    for (const category of ["metal", "crypto", "commodity", "fx"] as const) {
      categories[category] = await categoryAccess(pool, category, customer.jurisdiction);
    }
    return { residence: customer.jurisdiction, categories };
  });

  app.get("/api/jurisdictions", async () => publicCatalog(pool));

  app.post("/api/auth/register", async (req, reply) => {
    if (!allow(`reg:${clientIp(req)}`, 2, 5)) return reply.code(429).send({ error: "RATE_LIMITED" });
    const body = z
      .object({
        email: z.string().email().max(120),
        password: z.string().min(10).max(100),
        residenceCountry: z.string().length(2).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    let residence: string | null = null;
    if (body.data.residenceCountry) {
      residence = body.data.residenceCountry.toUpperCase();
      if (!knownPlace(residence)) return reply.code(403).send({ error: "JURISDICTION_CLOSED" });
      if (isLocked(residence)) return reply.code(403).send({ error: "JURISDICTION_BLOCKED" });
      const live = await pool.query(`SELECT access FROM jurisdiction_access WHERE country = $1`, [residence]);
      if (live.rows[0]?.access === "block") return reply.code(403).send({ error: "JURISDICTION_BLOCKED" });
    }
    try {
      await assertPassword(pool, body.data.password);
    } catch (err) {
      if (err instanceof PlatformError) return reply.code(err.status).send({ error: err.code });
      throw err;
    }
    const email = body.data.email.toLowerCase();
    const secret = generateTotpSecret();
    const inserted = await pool.query(
      `INSERT INTO users (email, password_hash, totp_secret) VALUES ($1,$2,$3)
       ON CONFLICT (email) DO NOTHING RETURNING id`,
      [email, hashPassword(body.data.password), secret],
    );
    if (!inserted.rowCount) return reply.code(409).send({ error: "EMAIL_TAKEN" });
    if (residence) {
      await pool.query(`UPDATE users SET jurisdiction = $2 WHERE id = $1`, [inserted.rows[0].id, residence]);
    }
    const otpauth = `otpauth://totp/MERIDEX:${encodeURIComponent(email)}?secret=${secret}&issuer=MERIDEX&algorithm=SHA1&digits=6&period=30`;
    const qrDataUrl = await QRCode.toDataURL(otpauth, { margin: 1, width: 220 });
    return { userId: Number(inserted.rows[0].id), totpSecret: secret, otpauth, qrDataUrl };
  });

  async function login(req: FastifyRequest, reply: FastifyReply) {
    if (!allow(`login:${clientIp(req)}`, 3, 8)) return reply.code(429).send({ error: "RATE_LIMITED" });
    const body = z
      .object({
        email: z.string().email(),
        password: z.string(),
        totp: z.string().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    const found = await pool.query(`SELECT * FROM users WHERE email = $1`, [body.data.email.toLowerCase()]);
    if (!found.rowCount) return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
    const user = found.rows[0];
    if (!verifyPassword(body.data.password, user.password_hash)) {
      return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
    }
    if (user.disabled) return reply.code(403).send({ error: "ACCOUNT_DISABLED" });
    const totpOn = user.totp_enabled !== false;
    const totpCode = body.data.totp;
    if (totpOn && !totpCode) return reply.code(401).send({ error: "MFA_REQUIRED" });
    if (totpOn && totpCode && !verifyTotp(user.totp_secret, totpCode)) return reply.code(401).send({ error: "INVALID_TOTP" });
    const country = lookupCountry(req);
    if (isSourceBlocked(policy, country)) {
      await recordAlert(pool, Number(user.id), req, country, user.jurisdiction, "block");
      return reply.code(403).send({ error: "GEO_BLOCKED" });
    }
    if (user.jurisdiction && country !== "ZZ" && country !== user.jurisdiction) {
      await recordAlert(pool, Number(user.id), req, country, user.jurisdiction, "alert");
    }
    const path = (req.url || "").split("?")[0];
    const portal = path.startsWith("/api/pool") ? "pool" : path.startsWith("/api/admin") ? "staff" : "customer";
    const staff = user.role === "admin" || user.role === "risk" || user.role === "ops" || user.role === "support";
    if (portal === "pool" && !user.address_pool_owner) {
      return reply.code(403).send({ error: "NOT_POOL_OWNER" });
    }
    if (portal === "customer" && staff) {
      return reply.code(403).send({
        error: "STAFF_PORTAL",
        portal: process.env.ADMIN_PUBLIC_URL || "http://127.0.0.1:4318",
      });
    }
    if (portal === "staff" && !staff) {
      return reply.code(403).send({
        error: "CUSTOMER_PORTAL",
        portal: process.env.CUSTOMER_PUBLIC_URL || "http://127.0.0.1:4317",
      });
    }
    const sid = await recordLogin(pool, Number(user.id), {
      ip: clientIp(req),
      country,
      userAgent: String(req.headers["user-agent"] ?? "").slice(0, 180) || null,
    });
    const token = signJwt(
      { sub: String(user.id), email: user.email, role: user.role, amr: ["pwd", "totp"], sid, portal },
      jwtSecret,
    );
    const cookie = portal === "staff"
      ? `meridex_staff=${encodeURIComponent(token)}; Path=/api/admin; HttpOnly; SameSite=Lax; Max-Age=43200`
      : portal === "pool"
        ? `meridex_pool=${encodeURIComponent(token)}; Path=/api/pool; HttpOnly; SameSite=Lax; Max-Age=43200`
        : `meridex_customer=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`;
    reply.header("Set-Cookie", cookie);
    return { token, role: user.role, portal };
  }

  app.post("/api/auth/login", login);
  app.post("/api/admin/auth/login", login);
  app.post("/api/pool/auth/login", login);
  app.post("/api/auth/logout", async (_req, reply) => {
    reply.header("Set-Cookie", "meridex_customer=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    return { ok: true };
  });
  app.post("/api/admin/auth/logout", async (_req, reply) => {
    reply.header("Set-Cookie", "meridex_staff=; Path=/api/admin; HttpOnly; SameSite=Lax; Max-Age=0");
    return { ok: true };
  });
  app.post("/api/pool/auth/logout", async (_req, reply) => {
    reply.header("Set-Cookie", "meridex_pool=; Path=/api/pool; HttpOnly; SameSite=Lax; Max-Age=0");
    return { ok: true };
  });

  app.get("/api/admin/me", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const flag = await pool.query(`SELECT address_pool_owner FROM users WHERE id = $1`, [user.id]);
    return { id: user.id, email: user.email, role: user.role, addressPoolOwner: Boolean(flag.rows[0]?.address_pool_owner) };
  });

  app.get("/api/pool/me", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const flag = await pool.query(`SELECT address_pool_owner FROM users WHERE id = $1`, [user.id]);
    if (!flag.rows[0]?.address_pool_owner) return reply.code(403).send({ error: "NOT_POOL_OWNER" });
    return { id: user.id, email: user.email, role: user.role, addressPoolOwner: true };
  });

  app.get("/api/me", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const row = await pool.query(
      `SELECT u.id, u.email, u.fund_id, u.role, u.entity_id, u.jurisdiction, u.vip_desk, u.is_internal_test,
              k.nationality, k.residence_country, k.sanctions_hit, k.status AS kyc_status, k.reason AS kyc_reason
       FROM users u LEFT JOIN kyc_profiles k ON k.user_id = u.id WHERE u.id = $1`,
      [user.id],
    );
    const me = row.rows[0];
    const internal = Boolean(me.is_internal_test);
    return {
      id: Number(me.id),
      fundId: me.fund_id ? String(me.fund_id) : "",
      email: me.email,
      role: me.role,
      entityId: me.entity_id,
      jurisdiction: me.jurisdiction,
      nationality: me.nationality,
      residenceCountry: me.residence_country,
      sanctionsHit: me.sanctions_hit,
      kycStatus: me.kyc_status ?? "none",
      kycReason: me.kyc_reason,
      vipDesk: Boolean(me.vip_desk),
      isInternalTest: internal,
      badge: internal ? "INTERNAL TEST / 内部测试" : null,
    };
  });

  app.post("/api/kyc", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (await blockPlay(reply, user.id)) return;
    const body = z
      .object({
        nationality: z.string().length(2),
        residenceCountry: z.string().length(2),
        sanctionsHit: z.boolean(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    const residence = body.data.residenceCountry.toUpperCase();
    const nationality = body.data.nationality.toUpperCase();
    // Sanctions hits and closed / blocked jurisdictions are still refused automatically.
    // Everything else waits for a human decision via POST /api/admin/kyc/:id/decision.
    // No entity, jurisdiction or ledger accounts are assigned at submit.
    const rules = decideKyc({ nationality, residenceCountry: residence, sanctionsHit: body.data.sanctionsHit }, policy);
    const autoReject = rules.status === "rejected";
    const status = autoReject ? "rejected" : "pending";
    const reason = autoReject ? rules.reason : "MANUAL_REVIEW";
    const current = await pool.query(
      `SELECT nationality, residence_country, sanctions_hit, status, reason FROM kyc_profiles WHERE user_id = $1`,
      [user.id],
    );
    const prev = current.rows[0];
    if (
      prev && prev.status === "approved" &&
      prev.nationality === nationality && prev.residence_country === residence && Boolean(prev.sanctions_hit) === body.data.sanctionsHit
    ) {
      // Unchanged details on an already-approved profile: nothing to review again.
      return { decision: "allow", trading: true, entityId: null, reason: String(prev.reason), status: "approved", edd: false };
    }
    await pool.query(
      `INSERT INTO kyc_profiles (user_id, nationality, residence_country, sanctions_hit, status, reason, entity_id, submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,NULL,now())
       ON CONFLICT (user_id) DO UPDATE SET
         nationality = EXCLUDED.nationality,
         residence_country = EXCLUDED.residence_country,
         sanctions_hit = EXCLUDED.sanctions_hit,
         status = EXCLUDED.status,
         reason = EXCLUDED.reason,
         entity_id = NULL,
         submitted_at = now(),
         reviewed_by = NULL,
         reviewed_at = NULL,
         review_note = NULL,
         updated_at = now()`,
      [user.id, nationality, residence, body.data.sanctionsHit, status, reason],
    );
    await pool.query(`INSERT INTO security_events (user_id, kind, detail) VALUES ($1,'kyc_submit',$2)`, [
      user.id,
      JSON.stringify({ status, reason, residence }),
    ]);
    return { decision: autoReject ? "deny" : "pending", trading: false, entityId: null, reason, status, edd: false };
  });

  app.post("/api/admin/kyc/:id/decision", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const id = String((req.params as { id: string }).id);
    const body = z
      .object({
        action: z.enum(["approve", "reject"]),
        reason: z.string().max(300).default(""),
        totp: z.string().max(32).optional(),
      })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await decideKycReview(pool, policy, user, id, body.data);
    } catch (err) {
      if (err instanceof PlatformError && (err.code === "FORBIDDEN" || err.code === "SELF_REVIEW")) {
        await logKycDenied(pool, user.id, id, err.code);
      }
      return fail(reply, err);
    }
  });

  app.get("/api/balances", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (await isInternalTest(pool, user.id)) return playBalances(pool, user.id);
    return balancesFor(pool, user.id);
  });

  async function blockPlay(reply: FastifyReply, userId: number): Promise<boolean> {
    try {
      await assertRealRails(pool, userId);
      return false;
    } catch (err) {
      if (err instanceof PlatformError) {
        reply.code(err.status).send({ error: err.code });
        return true;
      }
      throw err;
    }
  }

  app.get("/api/activity", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const q = req.query as { asset?: string; kind?: string };
    const asset = q.asset && /^[A-Z0-9]{2,12}$/.test(q.asset) ? q.asset : null;
    const kind = q.kind && /^[a-z_]{1,40}$/.test(q.kind) ? q.kind : null;
    const rows = await pool.query(
      `SELECT id, kind, asset, amount::text, detail, created_at FROM activity
       WHERE user_id = $1
         AND ($2::text IS NULL OR asset = $2)
         AND ($3::text IS NULL OR kind = $3)
       ORDER BY id DESC LIMIT 200`,
      [user.id, asset, kind],
    );
    return rows.rows;
  });

  app.get("/api/activity.csv", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const rows = await pool.query(
      `SELECT id, kind, asset, amount::text, detail, created_at FROM activity
       WHERE user_id = $1 ORDER BY id DESC LIMIT 500`,
      [user.id],
    );
    const lines = ["id,kind,asset,amount,detail,created_at"];
    for (const row of rows.rows) {
      const detail = String(row.detail ?? "").replaceAll('"', '""');
      lines.push(`${row.id},${row.kind},${row.asset},${row.amount},"${detail}",${row.created_at.toISOString?.() ?? row.created_at}`);
    }
    return reply.header("content-type", "text/csv; charset=utf-8").send(lines.join("\n"));
  });

  app.post("/api/wallet/deposit", async (req, reply) => {
    try {
      return await walletMove(req, reply, "deposit");
    } catch (err) {
      return fail(reply, err);
    }
  });
  app.post("/api/wallet/withdraw", async (req, reply) => {
    try {
      return await walletMove(req, reply, "withdraw");
    } catch (err) {
      return fail(reply, err);
    }
  });

  async function walletMove(req: FastifyRequest, reply: FastifyReply, kind: "deposit" | "withdraw") {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (await blockPlay(reply, user.id)) return;
    const gate = await tradingGate(pool, req, user, policy);
    if (gate) return reply.code(gate.status).send({ error: gate.error });
    const body = z.object({
      asset: z.enum(["USD", "XAU"]),
      amount: z.string(),
      stepUp: z.string().optional(),
      address: z.string().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    if (kind === "withdraw") {
      if (!allow(`wd:${user.id}`, 0.2, 2)) return reply.code(429).send({ error: "RATE_LIMITED" });
      try {
        await requireStepUp(pool, user.id, body.data.stepUp);
        await assertNotFrozen(pool, user.id);
        if (body.data.address) await assertWhitelist(pool, user.id, body.data.asset, body.data.address);
      } catch (err) {
        if (err instanceof PlatformError) return reply.code(err.status).send({ error: err.code });
        throw err;
      }
    }
    const scale = body.data.asset === "USD" ? 6 : 3;
    let gross: bigint;
    try {
      gross = parseScaled(body.data.amount, scale);
    } catch {
      return reply.code(400).send({ error: "VALIDATION" });
    }
    let amount = gross;
    if (body.data.asset === "USD") {
      try {
        amount = await adjustUsdMove(pool, kind, gross);
      } catch (err) {
        if (err instanceof PlatformError) return reply.code(err.status).send({ error: err.code });
        throw err;
      }
    }
    const customer = await loadCustomer(pool, user.id);
    if (!customer) return reply.code(403).send({ error: "KYC_REQUIRED" });
    if (kind === "withdraw" && await reviewRequired(pool, body.data.asset, gross)) {
      try {
        const queued = await enqueueWithdrawal(pool, {
          userId: user.id,
          customer,
          asset: body.data.asset,
          network: null,
          address: body.data.address ?? null,
          gross,
          ledger: amount,
          source: "wallet",
        });
        const balances = await balancesFor(pool, user.id);
        await pushUser(user.id);
        return { balances, status: "pending" as const, id: queued.id };
      } catch (err) {
        if (err instanceof PlatformError) return reply.code(err.status).send({ error: err.code });
        throw err;
      }
    }
    try {
      await withTx(pool, async (client) => {
        if (kind === "deposit") await deposit(client, customer, body.data.asset, amount);
        else await withdraw(client, customer, body.data.asset, amount);
      });
    } catch (err) {
      if (err instanceof LedgerError && err.code === "INSUFFICIENT_BALANCE") {
        return reply.code(400).send({ error: body.data.asset === "USD" ? "INSUFFICIENT_FUNDS" : "INSUFFICIENT_GOLD" });
      }
      throw err;
    }
    const balances = await balancesFor(pool, user.id);
    await pushUser(user.id);
    if (kind === "withdraw") {
      await noteAutoWithdraw(pool, {
        userId: user.id,
        customer,
        asset: body.data.asset,
        network: null,
        address: body.data.address ?? null,
        gross,
        ledger: amount,
        source: "wallet",
      });
    }
    if (kind === "deposit") {
      try {
        await onDepositCredited(pool, user.id, body.data.asset, body.data.amount);
      } catch (err) {
        console.error("deposit notice", err);
      }
    }
    return kind === "withdraw" ? { balances, status: "posted" as const } : { balances };
  }

  app.get("/api/wallet/catalog", async () => ({
    products: await redemptionCatalog(pool),
    note: "模拟交割。费用从余额扣除，没有真实物流。",
  }));

  app.get("/api/wallet/deposit-instructions", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (await blockPlay(reply, user.id)) return;
    return depositInstructions(pool, user.id);
  });

  app.get("/api/wallet/deposits", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    return { deposits: await listDeposits(pool, user.id) };
  });

  app.get("/api/wallet/deposit-claims", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (await blockPlay(reply, user.id)) return;
    return { claims: await listClaims(pool, user.id) };
  });

  app.post("/api/wallet/deposit-claims", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (await blockPlay(reply, user.id)) return;
    const body = z.object({
      asset: z.string().min(1).max(12),
      network: z.string().min(1).max(32),
      amount: z.string().min(1).max(40),
      reference: z.string().min(1).max(128),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await createClaim(pool, user.id, body.data);
    } catch (err) {
      if (err instanceof PlatformError) return reply.code(err.status).send({ error: err.code });
      throw err;
    }
  });

  app.get("/api/wallet/rails", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    return listRails(pool, user.id);
  });

  app.post("/api/wallet/rails", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (await blockPlay(reply, user.id)) return;
    const gate = await tradingGate(pool, req, user, policy);
    if (gate) return reply.code(gate.status).send({ error: gate.error });
    const body = z.object({
      direction: z.enum(["deposit", "withdraw"]),
      amount: z.string(),
      stepUp: z.string().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    if (body.data.direction === "withdraw") {
      try {
        await requireStepUp(pool, user.id, body.data.stepUp);
        await assertNotFrozen(pool, user.id);
      } catch (err) {
        if (err instanceof PlatformError) return reply.code(err.status).send({ error: err.code });
        throw err;
      }
    }
    let amount: bigint;
    try {
      amount = parseScaled(body.data.amount, 6);
    } catch {
      return reply.code(400).send({ error: "VALIDATION" });
    }
    if (amount <= 0n) return reply.code(400).send({ error: "VALIDATION" });
    const gross = amount;
    try {
      amount = await adjustUsdMove(pool, body.data.direction, amount);
    } catch (err) {
      if (err instanceof PlatformError) return reply.code(err.status).send({ error: err.code });
      throw err;
    }
    if (body.data.direction === "withdraw" && await reviewRequired(pool, "USD", gross)) {
      const customer = await loadCustomer(pool, user.id);
      if (!customer) return reply.code(403).send({ error: "KYC_REQUIRED" });
      try {
        const queued = await enqueueWithdrawal(pool, {
          userId: user.id,
          customer,
          asset: "USD",
          network: "Bank",
          address: null,
          gross,
          ledger: amount,
          source: "rail",
        });
        return { status: "pending" as const, id: queued.id };
      } catch (err) {
        return fail(reply, err);
      }
    }
    const row = await createRail(pool, user.id, body.data.direction, amount);
    if (body.data.direction === "withdraw") {
      const customer = await loadCustomer(pool, user.id);
      if (customer) {
        await noteAutoWithdraw(pool, {
          userId: user.id,
          customer,
          asset: "USD",
          network: "Bank",
          address: null,
          gross,
          ledger: amount,
          source: "rail",
        });
      }
    }
    return row;
  });

  app.get("/api/wallet/redemptions", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    return listRedemptions(pool, user.id);
  });

  app.post("/api/wallet/redemptions", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (await blockPlay(reply, user.id)) return;
    const gate = await tradingGate(pool, req, user, policy);
    if (gate) return reply.code(gate.status).send({ error: gate.error });
    const body = z
      .object({
        product: z.enum(["coin_1oz", "bar_100g", "bar_1000g"]),
        method: z.enum(["delivery", "vault_pickup"]),
        qty: z.number().int().min(1).max(20),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await createRedemption(pool, user.id, body.data.product, body.data.method, body.data.qty);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get("/api/account/sessions", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    return listSessions(pool, user.id);
  });

  app.post("/api/account/sessions/:id/revoke", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const ok = await revokeSession(pool, user.id, (req.params as { id: string }).id);
    if (!ok) return reply.code(404).send({ error: "NOT_FOUND" });
    return { ok: true };
  });

  app.get("/api/account/logins", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    return listLogins(pool, user.id);
  });

  app.get("/api/account/keys", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    return listApiKeys(pool, user.id);
  });

  app.post("/api/account/keys", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const body = z.object({
      label: z.string().min(1).max(40),
      scopes: z.string().optional(),
      ipWhitelist: z.string().optional(),
      stepUp: z.string().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      await requireStepUp(pool, user.id, body.data.stepUp);
      return await createApiKey(pool, user.id, body.data.label, { scopes: body.data.scopes, ipWhitelist: body.data.ipWhitelist });
    } catch (err) {
      if (err instanceof PlatformError) return reply.code(err.status).send({ error: err.code });
      throw err;
    }
  });

  app.post("/api/account/keys/:id/revoke", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const ok = await revokeApiKey(pool, user.id, (req.params as { id: string }).id);
    if (!ok) return reply.code(404).send({ error: "NOT_FOUND" });
    return { ok: true };
  });

  app.get("/api/account/notifications", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    return getPrefs(pool, user.id);
  });

  app.post("/api/account/notifications", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const body = z.object({ fills: z.boolean(), rejects: z.boolean(), announcements: z.boolean() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    return savePrefs(pool, user.id, body.data);
  });

  app.get("/api/alerts", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    return listAlerts(pool, user.id);
  });

  app.post("/api/alerts", async (req, reply) => {
    if (!allow(`alert:${clientIp(req)}`, 4, 8)) return reply.code(429).send({ error: "RATE_LIMITED" });
    const user = await requireUser(req, reply);
    if (!user) return;
    const body = z.object({
      symbol: z.string().min(3),
      direction: z.enum(["above", "below"]),
      price: z.string().min(1),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await createAlert(pool, user.id, body.data.symbol.toUpperCase(), body.data.direction, body.data.price);
    } catch (err) {
      const code = err instanceof Error ? err.message : "VALIDATION";
      return reply.code(400).send({ error: code === "UNKNOWN_SYMBOL" ? code : "VALIDATION" });
    }
  });

  app.delete("/api/alerts/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const ok = await deleteAlert(pool, user.id, (req.params as { id: string }).id);
    if (!ok) return reply.code(404).send({ error: "NOT_FOUND" });
    return { ok: true };
  });

  app.get("/api/notices", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    return { notices: await listNotices(pool, user.id) };
  });

  app.post("/api/notices/read", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    await markNoticesRead(pool, user.id);
    return { ok: true };
  });

  app.get("/api/watchlist", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    return { symbols: await listWatch(pool, user.id) };
  });

  app.post("/api/watchlist", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const body = z.object({ symbol: z.string().min(3) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return { symbols: await addWatch(pool, user.id, body.data.symbol.toUpperCase()) };
    } catch {
      return reply.code(400).send({ error: "UNKNOWN_SYMBOL" });
    }
  });

  app.delete("/api/watchlist", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const symbol = ((req.query as { symbol?: string }).symbol || "").toUpperCase();
    if (!symbol) return reply.code(400).send({ error: "VALIDATION" });
    return { symbols: await removeWatch(pool, user.id, symbol) };
  });

  app.get("/api/paper", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (await blockPlay(reply, user.id)) return;
    return paperView(pool, user.id);
  });

  app.post("/api/paper", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (await blockPlay(reply, user.id)) return;
    const body = z.object({ action: z.enum(["enable", "disable", "reset"]) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    if (body.data.action === "reset") return resetPaper(pool, user.id);
    if (body.data.action === "enable") {
      try {
        await assertMode(pool, user.id, "paper", true);
      } catch (err) {
        if (err instanceof ModeError) return reply.code(403).send({ error: err.code });
        throw err;
      }
    }
    return setPaperEnabled(pool, user.id, body.data.action === "enable");
  });

  app.get("/api/paper/orders", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (await blockPlay(reply, user.id)) return;
    return listPaperOrders(pool, user.id);
  });

  app.get("/api/paper/trades", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (await blockPlay(reply, user.id)) return;
    return listPaperTrades(pool, user.id);
  });

  app.post("/api/paper/orders/cancel-all", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (await blockPlay(reply, user.id)) return;
    try {
      return await cancelAllPaper(pool, user.id);
    } catch (err) {
      return paperFail(reply, err);
    }
  });

  app.post("/api/paper/orders/:id/cancel", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (await blockPlay(reply, user.id)) return;
    try {
      return await cancelPaperOrder(pool, user.id, (req.params as { id: string }).id);
    } catch (err) {
      return paperFail(reply, err);
    }
  });

  app.post("/api/paper/orders", async (req, reply) => {
    if (!allow(`paper:${clientIp(req)}`, 8, 20)) return reply.code(429).send({ error: "RATE_LIMITED" });
    const user = await requireUser(req, reply);
    if (!user) return;
    if (await blockPlay(reply, user.id)) return;
    const body = z
      .object({
        side: z.enum(["buy", "sell"]),
        type: z.enum(["limit", "market", "ioc", "fok", "post_only", "stop_limit", "oco"]),
        price: z.string().nullable().optional(),
        quantity: z.string(),
        symbol: z.string().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    const symbol = (body.data.symbol || "XAU/USD").toUpperCase();
    let inst: Instrument;
    try {
      inst = getInstrument(symbol);
    } catch {
      return reply.code(400).send({ error: "UNKNOWN_SYMBOL" });
    }
    try {
      const qty = parseScaled(body.data.quantity, inst.qtyDecimals);
      const price = body.data.type === "market" || body.data.price == null || body.data.price === ""
        ? null
        : parseScaled(body.data.price, inst.priceDecimals);
      return await placePaperOrder(pool, engine, user.id, {
        side: body.data.side,
        orderType: body.data.type,
        price,
        qty,
        symbol,
      });
    } catch (err) {
      return paperFail(reply, err);
    }
  });

  app.get("/api/account/portfolio", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (await isInternalTest(pool, user.id)) {
      const bal = await playBalances(pool, user.id);
      const equity = (bal.assets as { usd: string }[]).reduce((sum, row) => sum + BigInt(row.usd), 0n);
      const cash = BigInt(bal.USD.available) + BigInt(bal.USD.reserved);
      return {
        namespace: "play",
        enabled: false,
        play: true,
        equityUusd: equity.toString(),
        cashUusd: cash.toString(),
        baselineUusd: cash.toString(),
        pnlUusd: (equity - cash).toString(),
        curve: [],
        allocation: [],
        activity: [],
      };
    }
    const ns = (req.query as { namespace?: string }).namespace === "paper" ? "paper" : "real";
    return portfolioView(pool, user.id, ns);
  });

  app.post("/api/orders", async (req, reply) => {
    if (!allow(`ord:${clientIp(req)}`, 8, 16)) return reply.code(429).send({ error: "RATE_LIMITED" });
    const user = await requireUser(req, reply);
    if (!user) return;
    if (await isInternalTest(pool, user.id)) {
      try {
        const disabled = await pool.query(`SELECT disabled FROM users WHERE id = $1`, [user.id]);
        if (disabled.rows[0]?.disabled) return reply.code(403).send({ error: "ACCOUNT_DISABLED" });
        const body = z
          .object({
            side: z.enum(["buy", "sell"]),
            type: z.enum(["limit", "market", "ioc", "fok", "post_only", "stop_limit", "oco"]),
            price: z.string().nullable().optional(),
            stopPrice: z.string().nullable().optional(),
            quantity: z.string(),
            symbol: z.string().optional(),
          })
          .safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
        const symbol = (body.data.symbol || "XAU/USD").toUpperCase();
        let inst: Instrument;
        try {
          inst = getInstrument(symbol);
        } catch {
          return reply.code(400).send({ error: "UNKNOWN_SYMBOL" });
        }
        const qty = parseScaled(body.data.quantity, inst.qtyDecimals);
        const needsPrice = body.data.type !== "market";
        const price = needsPrice ? parseScaled(body.data.price ?? "", inst.priceDecimals) : null;
        const stop = body.data.type === "stop_limit" || body.data.type === "oco" ? parseScaled(body.data.stopPrice ?? "", inst.priceDecimals) : null;
        const result = await placePlayOrder(pool, engine, user.id, {
          side: body.data.side,
          orderType: body.data.type,
          priceCents: price,
          stopPriceCents: stop,
          qty,
          symbol,
        });
        if (result.rejectReason) return reply.code(409).send({ error: result.rejectReason, order: result });
        return result;
      } catch (err) {
        return fail(reply, err);
      }
    }
    try {
      const gate = await tradingGate(pool, req, user, policy);
      if (gate) return reply.code(gate.status).send({ error: gate.error });
      const body = z
        .object({
          side: z.enum(["buy", "sell"]),
          type: z.enum(["limit", "market", "ioc", "fok", "post_only", "stop_limit", "oco"]),
          price: z.string().nullable().optional(),
          stopPrice: z.string().nullable().optional(),
          stopLimitPrice: z.string().nullable().optional(),
          quantity: z.string(),
          symbol: z.string().optional(),
        })
        .safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
      const symbol = (body.data.symbol || "XAU/USD").toUpperCase();
      let inst: Instrument;
      try {
        inst = getInstrument(symbol);
      } catch {
        return reply.code(400).send({ error: "UNKNOWN_SYMBOL" });
      }
      const customer = await loadCustomer(pool, user.id);
      if (!customer) return reply.code(403).send({ error: "KYC_REQUIRED" });
      if (!offeredTo(customer.jurisdiction)) return reply.code(403).send({ error: "JURISDICTION_CLOSED" });
      const access = await categoryAccess(pool, inst.category, customer.jurisdiction);
      if (access === "block") return reply.code(403).send({ error: "CATEGORY_BLOCKED" });
      if (access !== "allow") return reply.code(403).send({ error: "CATEGORY_PENDING" });
      const qtyMg = parseScaled(body.data.quantity, inst.qtyDecimals);
      const needsPrice = body.data.type !== "market";
      const priceCents = needsPrice ? parseScaled(body.data.price ?? "", inst.priceDecimals) : null;
      const stopPriceCents =
        body.data.type === "stop_limit" || body.data.type === "oco" ? parseScaled(body.data.stopPrice ?? "", inst.priceDecimals) : null;
      const stopLimitCents = body.data.type === "oco" ? parseScaled(body.data.stopLimitPrice ?? body.data.stopPrice ?? "", inst.priceDecimals) : null;
      const result = await placeOrder(pool, engine, customer, {
        side: body.data.side,
        orderType: body.data.type,
        priceCents,
        qtyMg,
        stopPriceCents,
        stopLimitCents,
        symbol,
      });
      await broadcastBook();
      await pushUser(user.id);
      void ingestSafe(pool, { userId: user.id, kind: result.rejectReason === "SELF_TRADE" ? "self_trade" : "place", symbol });
      if (result.trades?.length) {
        let notion = 0n;
        for (const trade of result.trades) notion += BigInt(Math.round(trade.qty)) * BigInt(Math.round(trade.price));
        void ingestSafe(pool, { userId: user.id, kind: "trade", symbol, notionalUusd: notion });
        void accrueCommission(pool, user.id, notion).catch(() => undefined);
      }
      if (result.rejectReason) return reply.code(409).send({ error: result.rejectReason, order: result });
      return result;
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/api/orders/cancel-all", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (await isInternalTest(pool, user.id)) {
      try {
        return await cancelAllPlay(pool, user.id);
      } catch (err) {
        return fail(reply, err);
      }
    }
    try {
      const customer = await loadCustomer(pool, user.id);
      if (!customer) return reply.code(403).send({ error: "KYC_REQUIRED" });
      const result = await cancelAll(pool, engine, customer);
      await broadcastBook();
      await pushUser(user.id);
      return result;
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/api/orders/:id/amend", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (await isInternalTest(pool, user.id)) return reply.code(409).send({ error: "NOT_AMENDABLE" });
    try {
      const body = z.object({ price: z.string(), quantity: z.string() }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
      const customer = await loadCustomer(pool, user.id);
      if (!customer) return reply.code(403).send({ error: "KYC_REQUIRED" });
      const id = (req.params as { id: string }).id;
      const existing = await pool.query(`SELECT symbol FROM user_orders WHERE engine_order_id = $1`, [id]);
      const inst = getInstrument((existing.rows[0]?.symbol as string | undefined) ?? "XAU/USD");
      const result = await amendOrder(
        pool,
        engine,
        customer,
        id,
        parseScaled(body.data.price, inst.priceDecimals),
        parseScaled(body.data.quantity, inst.qtyDecimals),
      );
      await broadcastBook();
      await pushUser(user.id);
      if (result.rejectReason) return reply.code(409).send({ error: result.rejectReason, order: result });
      return result;
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/api/orders/:id/cancel", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (await isInternalTest(pool, user.id)) {
      try {
        return await cancelPlayOrder(pool, user.id, (req.params as { id: string }).id);
      } catch (err) {
        return fail(reply, err);
      }
    }
    try {
      const customer = await loadCustomer(pool, user.id);
      if (!customer) return reply.code(403).send({ error: "KYC_REQUIRED" });
      const result = await cancelOrder(pool, engine, customer, (req.params as { id: string }).id);
      await broadcastBook();
      await pushUser(user.id);
      void ingestSafe(pool, { userId: user.id, kind: "cancel" });
      return result;
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get("/api/orders", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (await isInternalTest(pool, user.id)) return listPlayOrders(pool, user.id);
    const rows = await pool.query(
      `SELECT engine_order_id, symbol, base_asset, quote_asset, side, order_type, price_cents::text, stop_price_cents::text, stop_limit_cents::text,
              group_id, qty_mg::text, leaves_mg::text, filled_mg::text, filled_notional_uusd::text,
              status, reject_reason, created_at
       FROM user_orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 80`,
      [user.id],
    );
    return rows.rows;
  });

  app.get("/api/trades", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (await isInternalTest(pool, user.id)) return listPlayTrades(pool, user.id);
    const rows = await pool.query(
      `SELECT engine_trade_id, symbol, price_cents::text, qty_mg::text, notional_uusd::text,
              buyer_id, seller_id, taker_side, tape_at,
              CASE WHEN buyer_id = $1 THEN buyer_fee_uusd ELSE seller_fee_uusd END::text AS fee_uusd
       FROM trades WHERE buyer_id = $1 OR seller_id = $1 ORDER BY tape_at DESC LIMIT 80`,
      [user.id],
    );
    return rows.rows.map((row) => {
      const userSide = Number(row.buyer_id) === user.id ? "buy" : "sell";
      const liquidity = row.taker_side === userSide ? "taker" : "maker";
      return { ...row, liquidity, userSide };
    });
  });

  app.get("/api/wallet/crypto", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    return listCrypto(pool, user.id);
  });

  app.post("/api/wallet/crypto", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (await blockPlay(reply, user.id)) return;
    const body = z
      .object({
        asset: z.string().min(2).max(12),
        network: z.string().min(2).max(40),
        direction: z.enum(["deposit", "withdraw"]),
        amount: z.string(),
        address: z.string().optional(),
        stepUp: z.string().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    const inst = loadCatalog().find((row) => row.base === body.data.asset.toUpperCase() && row.category === "crypto");
    if (!inst) return reply.code(400).send({ error: "UNKNOWN_SYMBOL" });
    if (!inst.networks.includes(body.data.network)) return reply.code(400).send({ error: "VALIDATION" });
    try {
      const amount = parseScaled(body.data.amount, inst.qtyDecimals);
      if (amount <= 0n) return reply.code(400).send({ error: "VALIDATION" });
      if (body.data.direction === "withdraw") {
        await requireStepUp(pool, user.id, body.data.stepUp);
        await assertNotFrozen(pool, user.id);
        await assertWhitelist(pool, user.id, inst.base, body.data.address ?? "");
        if (await reviewRequired(pool, inst.base, amount)) {
          const customer = await loadCustomer(pool, user.id);
          if (!customer) return reply.code(403).send({ error: "KYC_REQUIRED" });
          const queued = await enqueueWithdrawal(pool, {
            userId: user.id,
            customer,
            asset: inst.base,
            network: body.data.network,
            address: body.data.address ?? null,
            gross: amount,
            ledger: amount,
            source: "crypto",
          });
          return { status: "pending" as const, id: queued.id, asset: inst.base };
        }
      }
      const row = await createCrypto(pool, user.id, {
        asset: inst.base,
        network: body.data.network,
        direction: body.data.direction,
        amount,
      });
      if (body.data.direction === "withdraw") {
        const customer = await loadCustomer(pool, user.id);
        if (customer) {
          await noteAutoWithdraw(pool, {
            userId: user.id,
            customer,
            asset: inst.base,
            network: body.data.network,
            address: body.data.address ?? null,
            gross: amount,
            ledger: amount,
            source: "crypto",
          });
        }
      }
      return row;
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get("/api/admin/categories", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (user.role !== "admin") return reply.code(403).send({ error: "FORBIDDEN" });
    const rules = await pool.query(`SELECT category, country, access, updated_at FROM category_access ORDER BY category, country`);
    const audit = await pool.query(
      `SELECT id, category, country, previous_access, access, actor_email, created_at FROM category_audit ORDER BY id DESC LIMIT 30`,
    );
    return { rules: rules.rows, audit: audit.rows };
  });

  app.post("/api/admin/categories", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (user.role !== "admin") return reply.code(403).send({ error: "FORBIDDEN" });
    const body = z
      .object({
        category: z.enum(["metal", "crypto", "commodity", "fx"]),
        country: z.string().length(2),
        access: z.enum(["allow", "pending", "block"]),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    const country = body.data.country.toUpperCase();
    if (!knownPlace(country)) return reply.code(400).send({ error: "VALIDATION" });
    if (isLocked(country)) return reply.code(403).send({ error: "JURISDICTION_LOCKED" });
    const current = await pool.query(`SELECT access FROM category_access WHERE category = $1 AND country = $2`, [
      body.data.category,
      country,
    ]);
    const previous = (current.rows[0]?.access as string | undefined) ?? null;
    await pool.query(
      `INSERT INTO category_access (category, country, access, updated_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (category, country) DO UPDATE SET access = EXCLUDED.access, updated_at = now()`,
      [body.data.category, country, body.data.access],
    );
    await pool.query(
      `INSERT INTO category_audit (category, country, previous_access, access, actor_user_id, actor_email)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [body.data.category, country, previous, body.data.access, user.id, user.email],
    );
    const rules = await pool.query(`SELECT category, country, access, updated_at FROM category_access ORDER BY category, country`);
    return { rules: rules.rows };
  });

  app.get("/api/admin/jurisdictions", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (user.role !== "admin") return reply.code(403).send({ error: "FORBIDDEN" });
    return jurisdictionView(pool);
  });

  app.post("/api/admin/jurisdictions", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (user.role !== "admin") return reply.code(403).send({ error: "FORBIDDEN" });
    const body = z
      .object({
        country: z.string().length(2),
        access: z.enum(["allow", "pending", "block"]),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    const country = body.data.country.toUpperCase();
    if (!knownPlace(country)) return reply.code(400).send({ error: "VALIDATION" });
    if (isLocked(country)) return reply.code(403).send({ error: "JURISDICTION_LOCKED" });
    const current = await pool.query(`SELECT access, entity_id FROM jurisdiction_access WHERE country = $1`, [country]);
    const previous = (current.rows[0]?.access as string | undefined) ?? null;
    const entityId = entityFor(country, body.data.access, current.rows[0]?.entity_id ?? null);
    await pool.query(
      `INSERT INTO jurisdiction_access (country, access, entity_id, updated_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (country) DO UPDATE SET access = EXCLUDED.access, entity_id = EXCLUDED.entity_id, updated_at = now()`,
      [country, body.data.access, entityId],
    );
    await pool.query(
      `INSERT INTO jurisdiction_audit (country, previous_access, access, actor_user_id, actor_email)
       VALUES ($1,$2,$3,$4,$5)`,
      [country, previous, body.data.access, user.id, user.email],
    );
    policy = await loadPolicy(pool);
    return jurisdictionView(pool);
  });

  app.delete("/api/admin/jurisdictions/:country", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (user.role !== "admin") return reply.code(403).send({ error: "FORBIDDEN" });
    const country = (req.params as { country: string }).country.toUpperCase();
    if (isLocked(country)) return reply.code(403).send({ error: "JURISDICTION_LOCKED" });
    if (knownPlace(country)) return reply.code(400).send({ error: "VALIDATION" });
    const current = await pool.query(`SELECT access FROM jurisdiction_access WHERE country = $1`, [country]);
    if (!current.rowCount) return reply.code(404).send({ error: "NOT_FOUND" });
    await pool.query(`DELETE FROM jurisdiction_access WHERE country = $1`, [country]);
    await pool.query(
      `INSERT INTO jurisdiction_audit (country, previous_access, access, actor_user_id, actor_email)
       VALUES ($1,$2,'removed',$3,$4)`,
      [country, current.rows[0].access, user.id, user.email],
    );
    policy = await loadPolicy(pool);
    return jurisdictionView(pool);
  });

  app.get("/api/admin/users", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (user.role !== "admin") return reply.code(403).send({ error: "FORBIDDEN" });
    const rows = await pool.query(
      `SELECT u.id, u.email, u.role, u.entity_id, u.jurisdiction, u.created_at,
              k.nationality, k.residence_country, k.sanctions_hit, k.status AS kyc_status, k.reason AS kyc_reason
       FROM users u LEFT JOIN kyc_profiles k ON k.user_id = u.id
       ORDER BY u.id`,
    );
    return rows.rows;
  });

  app.get("/api/admin/alerts", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (user.role !== "admin") return reply.code(403).send({ error: "FORBIDDEN" });
    const rows = await pool.query(
      `SELECT g.id, g.user_id, u.email, g.ip, g.ip_country, g.residence_country, g.action, g.path, g.detail, g.created_at
       FROM geo_alerts g LEFT JOIN users u ON u.id = g.user_id
       ORDER BY g.id DESC LIMIT 100`,
    );
    return rows.rows;
  });

  app.post("/api/admin/replay", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (user.role !== "admin") return reply.code(403).send({ error: "FORBIDDEN" });
    // verify_replay compares the journal to the live book on the engine thread.
    // A later health() would race market-maker quotes and report a false mismatch.
    const replay = await engine.replayVerify();
    const all = await engine.replayAll();
    return {
      ok: replay.ok === true && all.ok === true,
      state_hash: replay.state_hash,
      liveHash: replay.state_hash,
      match: replay.ok === true && Boolean(replay.state_hash),
      books: all.books ?? [],
    };
  });

  app.get("/api/admin/invariants", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (user.role !== "admin") return reply.code(403).send({ error: "FORBIDDEN" });
    const client = await pool.connect();
    try {
      const checks = await checkInvariants(client);
      return { ok: checks.every((c) => c.ok), checks };
    } finally {
      client.release();
    }
  });

  app.post("/api/admin/halt", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (user.role !== "admin") return reply.code(403).send({ error: "FORBIDDEN" });
    const body = (req.body ?? {}) as { symbol?: string };
    const symbol = (body.symbol || "XAU/USD").toUpperCase();
    const result = await engine.command({ type: "halt" }, symbol);
    await broadcastBook();
    return result;
  });

  app.post("/api/admin/resume", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (user.role !== "admin") return reply.code(403).send({ error: "FORBIDDEN" });
    const body = (req.body ?? {}) as { symbol?: string };
    const symbol = (body.symbol || "XAU/USD").toUpperCase();
    const result = await engine.command({ type: "resume" }, symbol);
    await broadcastBook();
    return result;
  });

  registerModeRoutes(app, {
    pool,
    engine,
    requireUser,
    tradingGate: (req, user) => tradingGate(pool, req, user, policy),
  });

  registerContentRoutes(app, { pool, requireUser });

  app.get("/api/fees", async (req) => {
    const { feeView } = await import("./fees.js");
    const header = req.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null;
    const cookie = readCookie(req, "meridex_customer");
    const payload = verifyJwt(bearer || cookie || "", jwtSecret);
    const userId = payload && payload.portal === "customer" ? Number(payload.sub) : null;
    return feeView(pool, userId);
  });

  registerPlatformRoutes(app, {
    pool,
    requireUser,
    allow,
    marketBook: async (symbol) => mapBook(await engine.book(symbol), getInstrument(symbol)),
    marketTrades: async (symbol) => recentTrades(pool, 40, symbol),
    onChange: async () => {
      policy = await loadPolicy(pool);
    },
  });

  await app.ready();
  const wss = new WebSocketServer({ server: app.server, path: "/ws" });
  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "/ws", "http://localhost");
    const token = url.searchParams.get("token");
    const payload = token ? verifyJwt(token, jwtSecret) : null;
    const urlSymbol = url.searchParams.get("symbol") || "XAU/USD";
    const urlTf = url.searchParams.get("tf") || "1m";
    const client: Client = {
      ws,
      userId: payload?.portal === "customer" ? Number(payload.sub) : null,
      symbol: urlSymbol,
      tf: isTf(urlTf) ? urlTf : "1m",
    };
    const apiKey = url.searchParams.get("apiKey");
    const ts = url.searchParams.get("ts");
    const sign = url.searchParams.get("sign");
    if (apiKey && ts && sign) {
      const forwarded = req.headers["x-forwarded-for"];
      const ip = (typeof forwarded === "string" ? forwarded.split(",")[0].trim() : "") || req.socket.remoteAddress || "";
      void verifySigned(pool, { keyId: apiKey, ts, signature: sign, method: "GET", path: "/ws", body: "", ip }).then((auth) => {
        if (scopeOk(auth.scopes, "read")) {
          client.userId = auth.userId;
          void pushUser(auth.userId);
        }
      }).catch(() => undefined);
    }
    clients.add(client);
    void broadcastBook();
    ws.on("message", (buf) => {
      try {
        const msg = JSON.parse(buf.toString()) as { type?: string; symbol?: string; tf?: string };
        if (msg.type === "ping") {
          client.ws.send(JSON.stringify({ type: "pong", t: Date.now() }));
          return;
        }
        if (msg.type === "subscribe") {
          if (msg.symbol) client.symbol = msg.symbol;
          if (msg.tf && isTf(msg.tf)) client.tf = msg.tf;
          void broadcastBook();
        }
      } catch {
        /* ignore malformed frames */
      }
    });
    ws.on("close", () => clients.delete(client));
  });

  return { app, broadcastBook, startBackground: async () => {
    const repaired = await repairUnsettledTrades(pool, engine);
    if (repaired) console.log(`repaired ${repaired} book trades`);
    const recovered = await recoverPending(pool, engine);
    if (recovered) console.log(`recovered ${recovered} pending orders`);
    const mm = await loadBot(pool, "bot-mm@internal.meridex");
    const flow = await loadBot(pool, "bot-flow@internal.meridex");
    await ensureInstruments(pool);
    const demo = await pool.query(`SELECT id, entity_id, jurisdiction FROM users WHERE email = 'client@meridexexchange.com'`);
    const demoRef = demo.rowCount
      ? { id: Number(demo.rows[0].id), entityId: demo.rows[0].entity_id as string, jurisdiction: demo.rows[0].jurisdiction as string }
      : null;
    if (mm && flow) await ensureFloats(pool, [mm, flow], demoRef);
    await backfillCandles(pool);
    if (mm && flow && process.env.BOTS !== "0") {
      await primeBooks(pool, engine, mm, flow);
      startBots(pool, engine, mm, flow, broadcastBook);
      startMakers(pool, engine, mm, flow, broadcastBook);
      console.log("market-maker bots running");
    }
    void enrichCryptoCandles(pool).catch(() => undefined);
    await startGlobalLoop();
    startAlertLoop(pool, engine);
    startRecurringLoop(pool, engine);
    setInterval(() => {
      void pulseDemoAlert(pool).catch((err) => console.error("surv pulse", err));
    }, 90_000);
    setInterval(() => {
      void advanceWorkflows(pool).catch((err) => console.error("workflow", err));
    }, Number(process.env.WORKFLOW_STEP_MS ?? 1200));
    setInterval(() => {
      void sweepPlay(pool, engine).catch((err) => console.error("play sweep", err));
    }, 2000);
    bindLiquidityPool(pool);
    startMarkLoop();
  } };
}

async function recentTrades(pool: Db, limit: number, symbol = "XAU/USD") {
  const rows = await pool.query(
    `SELECT engine_trade_id, symbol, price_cents::text, qty_mg::text, notional_uusd::text, taker_side, tape_at
     FROM trades WHERE symbol = $2 ORDER BY tape_at DESC LIMIT $1`,
    [limit, symbol],
  );
  return rows.rows;
}

/** Evenly sampled prints across the session so the chart keeps the opening path. */
async function chartSeries(pool: Db, points: number, symbol = "XAU/USD") {
  const rows = await pool.query(
    `WITH ordered AS (
       SELECT engine_trade_id, price_cents::text, qty_mg::text, notional_uusd::text, taker_side, tape_at,
              row_number() OVER (ORDER BY tape_at, engine_trade_id) AS rn,
              count(*) OVER () AS n
       FROM trades
       WHERE symbol = $2
     )
     SELECT engine_trade_id, price_cents, qty_mg, notional_uusd, taker_side, tape_at
     FROM ordered
     WHERE n <= $1::bigint
        OR rn = 1
        OR rn = n
        OR mod(rn, GREATEST(1, (n / $1::bigint))) = 0
     ORDER BY rn`,
    [points, symbol],
  );
  return rows.rows;
}

async function balancesFor(pool: Db, userId: number) {
  const user = await pool.query(`SELECT entity_id, jurisdiction FROM users WHERE id = $1`, [userId]);
  const rows = await pool.query(
    `SELECT a.asset, a.bucket, b.amount::text AS amount
     FROM accounts a JOIN balances b ON b.account_id = a.id
     WHERE a.customer_id = $1 AND a.bucket IN ('available','reserved','withdraw_hold')`,
    [userId],
  );
  const out: Record<string, { available: string; reserved: string }> = {
    USD: { available: "0", reserved: "0" },
    XAU: { available: "0", reserved: "0" },
  };
  for (const row of rows.rows) {
    const slot = out[row.asset] ?? { available: "0", reserved: "0" };
    out[row.asset] = slot;
    if (row.bucket === "available") slot.available = row.amount;
    if (row.bucket === "reserved" || row.bucket === "withdraw_hold") {
      slot.reserved = (BigInt(slot.reserved) + BigInt(row.amount)).toString();
    }
  }
  const catalog = loadCatalog();
  const assets = Object.entries(out)
    .filter(([, slot]) => slot.available !== "0" || slot.reserved !== "0")
    .map(([asset, slot]) => {
      const inst = catalog.find((row) => row.base === asset && row.quote === "USD");
      let usd = "0";
      if (asset === "USD") usd = slot.available;
      else if (inst) {
        usd = ((BigInt(slot.available) * BigInt(inst.refPrice) * BigInt(inst.quoteScale)) / (BigInt(inst.qtyScale) * BigInt(inst.priceScale))).toString();
      }
      return { asset, available: slot.available, reserved: slot.reserved, usd, qtyScale: inst?.qtyScale ?? (asset === "USD" ? 1_000_000 : 1000), qtyDecimals: inst?.qtyDecimals ?? (asset === "XAU" ? 3 : 4) };
    });
  return {
    entityId: user.rows[0]?.entity_id ?? null,
    jurisdiction: user.rows[0]?.jurisdiction ?? null,
    USD: out.USD,
    XAU: out.XAU,
    assets,
  };
}

async function tradingGate(pool: Db, req: FastifyRequest, user: Authed, policy: Policy) {
  const profile = await pool.query(
    `SELECT status, residence_country, reason, sanctions_hit FROM kyc_profiles WHERE user_id = $1`,
    [user.id],
  );
  if (!profile.rowCount) return { status: 403, error: "KYC_REQUIRED" };
  const frozen = await pool.query(`SELECT frozen FROM users WHERE id = $1`, [user.id]);
  if (frozen.rows[0]?.frozen) return { status: 403, error: "ACCOUNT_FROZEN" };
  const country = lookupCountry(req);
  const residence = profile.rows[0].residence_country as string;
  if (isSourceBlocked(policy, country)) {
    await recordAlert(pool, user.id, req, country, residence, "block");
    return { status: 403, error: "GEO_BLOCKED" };
  }
  if (country !== "ZZ" && country !== residence) {
    await recordAlert(pool, user.id, req, country, residence, "alert");
  }
  if (profile.rows[0].sanctions_hit) return { status: 403, error: "SANCTIONS_HIT" };
  const access = policy.byCountry[residence]?.access;
  if (access === "block") return { status: 403, error: "JURISDICTION_BLOCKED" };
  if (access === "pending") return { status: 403, error: "KYC_PENDING" };
  if (!access) return { status: 403, error: "JURISDICTION_CLOSED" };
  if (!canTrade(profile.rows[0].status)) {
    const reason = profile.rows[0].reason as string;
    const error = reason === "SANCTIONS_HIT" ? reason : profile.rows[0].status === "pending" ? "KYC_PENDING" : "KYC_REJECTED";
    return { status: 403, error };
  }
  return null;
}

async function jurisdictionView(pool: Db) {
  return adminCatalog(pool);
}

async function recordAlert(
  pool: Db,
  userId: number,
  req: FastifyRequest,
  country: string,
  residence: string | null,
  action: "alert" | "block",
) {
  await pool.query(
    `INSERT INTO geo_alerts (user_id, ip, ip_country, residence_country, action, path, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [userId, clientIp(req), country, residence, action, req.url, action === "block" ? "来源国已被合规设为关闭" : "来源国与 KYC 居住地不一致"],
  );
}

export async function boot() {
  const databaseUrl = process.env.DATABASE_URL ?? "postgres://meridex:<redacted>@127.0.0.1:5432/meridex";
  const engineUrl = process.env.ENGINE_URL ?? "http://127.0.0.1:7109";
  const jwtSecret = process.env.JWT_SECRET ?? "<redacted>";
  const port = Number(process.env.GATEWAY_PORT ?? 7108);
  const host = process.env.GATEWAY_HOST || process.env.HOST || "127.0.0.1";
  const pool = createPool(databaseUrl);
  await migrate(pool);
  await ensureCoverage(pool);
  const { EngineClient } = await import("./engineClient.js");
  const engine = new EngineClient(engineUrl);
  for (let i = 0; i < 60; i++) {
    try {
      await engine.health();
      break;
    } catch (err) {
      if (i === 59) throw err;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  if (process.env.SEED_DEMO !== "0") {
    await seedDemo(pool, engine);
    await seedPlatform(pool);
  }
  const built = await buildServer(pool, engine, jwtSecret);
  await built.startBackground();
  await built.app.listen({ port, host });
  console.log(`meridex-gateway listening on ${host}:${port}`);
  return built;
}
