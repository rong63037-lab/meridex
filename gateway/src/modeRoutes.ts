import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { asConvertError, convertHistory, executeConvert, quoteConvert } from "./convert.js";
import type { Db } from "./db.js";
import {
  asDemoError,
  borrowMargin,
  closePerp,
  copyState,
  followLeader,
  marginView,
  openPerp,
  perpBoard,
  repayMargin,
  setMargin,
} from "./demoModes.js";
import type { EngineClient } from "./engineClient.js";
import { getInstrument } from "./instruments.js";
import { houseExposure, listProducts, LiveError, setProduct, transferWallet, walletView } from "./liveCommon.js";
import { referenceAdmin, setReference } from "./referenceDepth.js";
import { copyBoardMarked, followLeaderLive, leaderProfile, setFollow, setLeader } from "./liveCopy.js";
import { LedgerError } from "./ledger.js";
import {
  adjustMargin,
  cancelOrder,
  closeAll,
  closePosition,
  liveBoard,
  placeOrder,
  setLiveSettings,
  settleDue,
} from "./liveTrade.js";
import { ModeError, modeView, setModeAccess, type Mode } from "./modes.js";
import { paperEnabled } from "./paper.js";
import { asPlanError, createPlan, listPlans, runPlan, setClock, setPlanStatus, type Cadence } from "./recurring.js";
import { parseScaled } from "./units.js";
import { PlatformError } from "./platform.js";
import { assertRealRails } from "./play.js";

type Authed = { id: number; email: string; role: string };

function statusFor(code: string): number {
  if (code === "NOT_FOUND") return 404;
  if (
    code === "DEMO_ONLY" ||
    code === "LIVE_OFF" ||
    code === "PLAY_ONLY" ||
    code === "FORBIDDEN" ||
    code === "US_RETAIL_BLOCK" ||
    code === "MODE_BLOCKED" ||
    code === "MODE_PENDING" ||
    code === "KYC_REQUIRED" ||
    code === "KYC_PENDING" ||
    code === "CATEGORY_PENDING" ||
    code === "CATEGORY_BLOCKED" ||
    code === "MARKET_HALTED" ||
    code === "PAPER_OFF" ||
    code === "JURISDICTION_CLOSED" ||
    code === "JURISDICTION_LOCKED"
  ) {
    return 403;
  }
  if (
    code === "QUOTE_EXPIRED" ||
    code === "SLIPPAGE" ||
    code === "EMPTY_BOOK" ||
    code === "INSUFFICIENT_FUNDS" ||
    code === "INSUFFICIENT_GOLD" ||
    code === "INSUFFICIENT_BALANCE" ||
    code === "PLAN_INACTIVE" ||
    code === "CAP_NOTIONAL" ||
    code === "CAP_LEVERAGE" ||
    code === "HOUSE_SHORT" ||
    code === "REDUCE_ONLY" ||
    code === "BELOW_MAINTENANCE" ||
    code === "LP_KILLED" ||
    code === "LP_REJECTED" ||
    code === "LP_RESTING" ||
    code === "LP_CAP" ||
    code === "LP_DOCS_REQUIRED"
  ) {
    return 409;
  }
  return 400;
}

function sendErr(reply: FastifyReply, err: unknown) {
  if (err instanceof PlatformError) return reply.code(err.status).send({ error: err.code });
  if (err instanceof LiveError) return reply.code(statusFor(err.code)).send({ error: err.code });
  if (err instanceof LedgerError) {
    const code = err.code === "INSUFFICIENT_BALANCE" ? "INSUFFICIENT_FUNDS" : err.code;
    return reply.code(statusFor(code)).send({ error: code });
  }
  const known = asConvertError(err) ?? asPlanError(err) ?? asDemoError(err);
  if (known) return reply.code(statusFor(known.code)).send({ error: known.code });
  if (err instanceof Error && err.message === "VALIDATION") return reply.code(400).send({ error: "VALIDATION" });
  console.error(err);
  return reply.code(500).send({ error: "INTERNAL" });
}

export function registerModeRoutes(
  app: FastifyInstance,
  deps: {
    pool: Db;
    engine: EngineClient;
    requireUser: (req: FastifyRequest, reply: FastifyReply) => Promise<Authed | null>;
    tradingGate: (req: FastifyRequest, user: Authed) => Promise<{ status: number; error: string } | null>;
  },
) {
  const { pool, engine, requireUser, tradingGate } = deps;

  async function requireLive(req: FastifyRequest, reply: FastifyReply) {
    const user = await requireUser(req, reply);
    if (!user) return null;
    try {
      await assertRealRails(pool, user.id);
    } catch (err) {
      if (err instanceof PlatformError) {
        reply.code(err.status).send({ error: err.code });
        return null;
      }
      throw err;
    }
    return user;
  }

  app.post("/api/convert/quote", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    const gate = await tradingGate(req, user);
    if (gate) return reply.code(gate.status).send({ error: gate.error });
    const body = z
      .object({
        symbol: z.string().min(3),
        side: z.enum(["buy", "sell"]),
        quantity: z.string(),
        slippageBps: z.number().int().optional(),
        paper: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      const inst = getInstrument(body.data.symbol.toUpperCase());
      const qty = parseScaled(body.data.quantity, inst.qtyDecimals);
      return await quoteConvert(pool, engine, user.id, {
        symbol: inst.symbol,
        side: body.data.side,
        qty,
        slippageBps: body.data.slippageBps ?? 30,
        paper: Boolean(body.data.paper),
      });
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/api/convert/execute", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    const gate = await tradingGate(req, user);
    if (gate) return reply.code(gate.status).send({ error: gate.error });
    const body = z.object({ quoteId: z.string().uuid() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await executeConvert(pool, engine, user.id, body.data.quoteId);
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.get("/api/convert/history", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    return convertHistory(pool, user.id);
  });

  app.get("/api/recurring", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    return listPlans(pool, user.id);
  });

  app.post("/api/recurring/clock", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    const body = z.object({ multiplier: z.number().int().min(1).max(3600) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    return { multiplier: await setClock(pool, body.data.multiplier) };
  });

  app.post("/api/recurring", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    const gate = await tradingGate(req, user);
    if (gate) return reply.code(gate.status).send({ error: gate.error });
    const body = z
      .object({
        symbol: z.string().min(3),
        amount: z.string(),
        cadence: z.enum(["daily", "weekly", "monthly"]),
        paper: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      const inst = getInstrument(body.data.symbol.toUpperCase());
      return await createPlan(pool, user.id, {
        symbol: inst.symbol,
        amountUusd: parseScaled(body.data.amount, 6),
        cadence: body.data.cadence as Cadence,
        paper: Boolean(body.data.paper),
      });
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/api/recurring/:id", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    const body = z.object({ action: z.enum(["pause", "resume", "cancel"]) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await setPlanStatus(pool, user.id, (req.params as { id: string }).id, body.data.action);
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/api/recurring/:id/run", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    const gate = await tradingGate(req, user);
    if (gate) return reply.code(gate.status).send({ error: gate.error });
    try {
      return await runPlan(pool, engine, user.id, (req.params as { id: string }).id, true);
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  async function owner(req: FastifyRequest, reply: FastifyReply) {
    const user = await requireUser(req, reply);
    if (!user) return null;
    const flag = await pool.query(`SELECT address_pool_owner FROM users WHERE id = $1`, [user.id]);
    if (!flag.rows[0]?.address_pool_owner) {
      reply.code(403).send({ error: "FORBIDDEN" });
      return null;
    }
    return user;
  }

  async function staff(req: FastifyRequest, reply: FastifyReply) {
    const user = await requireUser(req, reply);
    if (!user) return null;
    if (!["admin", "ops", "support", "risk"].includes(user.role)) {
      reply.code(403).send({ error: "FORBIDDEN" });
      return null;
    }
    return user;
  }

  app.get("/api/wallets", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    return walletView(pool, user.id);
  });

  app.post("/api/wallets/transfer", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    const body = z
      .object({
        from: z.enum(["spot", "margin", "derivatives"]),
        to: z.enum(["spot", "margin", "derivatives"]),
        amount: z.string(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await transferWallet(pool, user.id, body.data.from, body.data.to, parseScaled(body.data.amount, 6));
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.get("/api/margin", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    try {
      if (await paperEnabled(pool, user.id)) return await marginView(pool, engine, user.id);
      return await liveBoard(pool, engine, user.id, "margin");
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/api/margin", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    const body = z
      .object({ mode: z.enum(["cross", "isolated"]).optional(), leverage: z.number().int().min(2).max(10).optional() })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      if (await paperEnabled(pool, user.id)) return await setMargin(pool, user.id, body.data);
      return await setLiveSettings(pool, user.id, "margin", body.data);
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/api/margin/borrow", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    const body = z.object({ amount: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      if (!(await paperEnabled(pool, user.id))) throw new LiveError("LIVE_OFF");
      return await borrowMargin(pool, user.id, parseScaled(body.data.amount, 6));
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/api/margin/repay", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    const body = z.object({ amount: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      if (!(await paperEnabled(pool, user.id))) throw new LiveError("LIVE_OFF");
      return await repayMargin(pool, user.id, parseScaled(body.data.amount, 6));
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  const orderBody = z.object({
    symbol: z.string(),
    side: z.enum(["buy", "sell"]),
    quantity: z.string(),
    leverage: z.number().int().min(2).max(10),
    orderType: z.enum(["market", "limit"]).optional(),
    price: z.string().nullable().optional(),
    reduceOnly: z.boolean().optional(),
    tp: z.string().nullable().optional(),
    sl: z.string().nullable().optional(),
    marginMode: z.enum(["cross", "isolated"]).optional(),
  });

  async function postOrder(userId: number, product: "margin" | "perp", raw: unknown) {
    const body = orderBody.safeParse(raw);
    if (!body.success) throw new LiveError("VALIDATION");
    if (await paperEnabled(pool, userId)) {
      if (product !== "perp") throw new LiveError("VALIDATION");
      const spot = body.data.symbol === "BTC-PERP" ? "BTC/USD" : body.data.symbol === "ETH-PERP" ? "ETH/USD" : "XAU/USD";
      const inst = getInstrument(spot);
      return openPerp(pool, engine, userId, {
        symbol: body.data.symbol,
        side: body.data.side,
        qty: parseScaled(body.data.quantity, inst.qtyDecimals),
        leverage: body.data.leverage,
        tp: body.data.tp ? parseScaled(body.data.tp, inst.priceDecimals) : null,
        sl: body.data.sl ? parseScaled(body.data.sl, inst.priceDecimals) : null,
      });
    }
    const spot = product === "perp"
      ? body.data.symbol === "BTC-PERP"
        ? "BTC/USD"
        : body.data.symbol === "ETH-PERP"
          ? "ETH/USD"
          : "XAU/USD"
      : body.data.symbol;
    const inst = getInstrument(spot);
    return placeOrder(pool, engine, userId, product, {
      symbol: body.data.symbol,
      side: body.data.side,
      qty: parseScaled(body.data.quantity, inst.qtyDecimals),
      leverage: body.data.leverage,
      orderType: body.data.orderType ?? "market",
      limitPx: body.data.price ? parseScaled(body.data.price, inst.priceDecimals) : null,
      reduceOnly: Boolean(body.data.reduceOnly),
      tp: body.data.tp ? parseScaled(body.data.tp, inst.priceDecimals) : null,
      sl: body.data.sl ? parseScaled(body.data.sl, inst.priceDecimals) : null,
      marginMode: body.data.marginMode,
    });
  }

  app.post("/api/margin/orders", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    try {
      return await postOrder(user.id, "margin", req.body);
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/api/margin/orders/:id/cancel", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    try {
      return await cancelOrder(pool, user.id, "margin", (req.params as { id: string }).id);
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/api/margin/positions/:id/close", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    const body = z.object({ quantity: z.string().optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      const id = (req.params as { id: string }).id;
      const row = await pool.query(`SELECT symbol FROM real_positions WHERE id = $1 AND user_id = $2`, [id, user.id]);
      const inst = getInstrument(String(row.rows[0]?.symbol ?? "XAU/USD"));
      const qty = body.data.quantity ? parseScaled(body.data.quantity, inst.qtyDecimals) : null;
      return await closePosition(pool, engine, user.id, "margin", id, qty);
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/api/margin/positions/:id/margin", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    const body = z.object({ action: z.enum(["add", "remove"]), amount: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await adjustMargin(pool, user.id, "margin", (req.params as { id: string }).id, body.data.action, parseScaled(body.data.amount, 6));
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/api/margin/close-all", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    try {
      return await closeAll(pool, engine, user.id, "margin");
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.get("/api/perps", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    try {
      if (await paperEnabled(pool, user.id)) return await perpBoard(pool, engine, user.id);
      return await liveBoard(pool, engine, user.id, "perp");
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/api/perps/settings", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    const body = z
      .object({ mode: z.enum(["cross", "isolated"]).optional(), leverage: z.number().int().min(2).max(10).optional() })
      .safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await setLiveSettings(pool, user.id, "perp", body.data);
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/api/perps/orders", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    try {
      return await postOrder(user.id, "perp", req.body);
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/api/perps/orders/:id/cancel", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    try {
      return await cancelOrder(pool, user.id, "perp", (req.params as { id: string }).id);
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/api/perps/close-all", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    try {
      return await closeAll(pool, engine, user.id, "perp");
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/api/perps/:id/close", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    const body = z.object({ quantity: z.string().optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      if (await paperEnabled(pool, user.id)) return await closePerp(pool, engine, user.id, (req.params as { id: string }).id);
      const id = (req.params as { id: string }).id;
      const row = await pool.query(`SELECT symbol FROM real_positions WHERE id = $1 AND user_id = $2`, [id, user.id]);
      const symbol = String(row.rows[0]?.symbol ?? "XAU-PERP");
      const spot = symbol === "BTC-PERP" ? "BTC/USD" : symbol === "ETH-PERP" ? "ETH/USD" : "XAU/USD";
      const inst = getInstrument(spot);
      const qty = body.data.quantity ? parseScaled(body.data.quantity, inst.qtyDecimals) : null;
      return await closePosition(pool, engine, user.id, "perp", id, qty);
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/api/perps/:id/margin", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    const body = z.object({ action: z.enum(["add", "remove"]), amount: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await adjustMargin(pool, user.id, "perp", (req.params as { id: string }).id, body.data.action, parseScaled(body.data.amount, 6));
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.get("/api/copy", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    try {
      if (await paperEnabled(pool, user.id)) return await copyState(pool, user.id);
      return await copyBoardMarked(pool, engine, user.id);
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/api/copy/follow", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    const body = z
      .object({
        leaderId: z.string(),
        allocation: z.string(),
        maxDrawdownBps: z.number().int().optional(),
        ratioBps: z.number().int().optional(),
        maxLoss: z.string().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      if (await paperEnabled(pool, user.id)) {
        return await followLeader(pool, engine, user.id, {
          leaderId: body.data.leaderId,
          allocationUusd: parseScaled(body.data.allocation, 6),
          maxDrawdownBps: body.data.maxDrawdownBps ?? 800,
        });
      }
      return await followLeaderLive(pool, user.id, {
        leaderId: Number(body.data.leaderId),
        allocation: parseScaled(body.data.allocation, 6),
        ratioBps: body.data.ratioBps ?? 10_000,
        maxLoss: parseScaled(body.data.maxLoss ?? body.data.allocation, 6),
      });
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/api/copy/lead", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    const body = z.object({ displayName: z.string().optional(), optedIn: z.boolean() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await setLeader(pool, user.id, body.data.displayName ?? "", body.data.optedIn);
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.get("/api/copy/leaders/:id", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    try {
      return await leaderProfile(pool, Number((req.params as { id: string }).id));
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/api/copy/follows/:id", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    const body = z.object({ action: z.enum(["pause", "resume", "stop"]) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await setFollow(pool, engine, user.id, (req.params as { id: string }).id, body.data.action);
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.get("/api/admin/live-products", async (req, reply) => {
    const user = await owner(req, reply);
    if (!user) return;
    try {
      return { ...(await listProducts(pool)), exposure: await houseExposure(pool, engine) };
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/api/admin/live-products", async (req, reply) => {
    const user = await owner(req, reply);
    if (!user) return;
    const body = z
      .object({
        product: z.enum(["margin", "perp", "copy"]),
        enabled: z.boolean(),
        maxNotionalUsd: z.string(),
        maxLeverage: z.number().int(),
        totp: z.string().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await setProduct(pool, user, {
        product: body.data.product,
        enabled: body.data.enabled,
        maxNotional: parseScaled(body.data.maxNotionalUsd, 6),
        maxLeverage: body.data.maxLeverage,
        totp: body.data.totp,
      });
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.get("/api/admin/reference-depth", async (req, reply) => {
    const user = await owner(req, reply);
    if (!user) return;
    try {
      return await referenceAdmin(pool);
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/api/admin/reference-depth", async (req, reply) => {
    const user = await owner(req, reply);
    if (!user) return;
    const body = z.object({ enabled: z.boolean(), totp: z.string().optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await setReference(pool, user, body.data);
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.get("/api/admin/live-exposure", async (req, reply) => {
    const user = await staff(req, reply);
    if (!user) return;
    try {
      return await houseExposure(pool, engine);
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/api/admin/live-settle", async (req, reply) => {
    const user = await owner(req, reply);
    if (!user) return;
    const body = z.object({ totp: z.string().optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      const { requireFreshTotp } = await import("./pool.js");
      await requireFreshTotp(pool, user.id, body.data.totp);
      await settleDue(pool, engine);
      return { ok: true, exposure: await houseExposure(pool, engine) };
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.get("/api/admin/modes", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    if (user.role !== "admin") return reply.code(403).send({ error: "FORBIDDEN" });
    return modeView(pool);
  });

  app.post("/api/admin/modes", async (req, reply) => {
    const user = await requireLive(req, reply);
    if (!user) return;
    if (user.role !== "admin") return reply.code(403).send({ error: "FORBIDDEN" });
    const body = z
      .object({
        mode: z.enum(["convert", "recurring", "paper", "margin", "perp", "copy"]),
        country: z.string().length(2),
        access: z.enum(["allow", "pending", "block"]),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      await setModeAccess(pool, user, body.data.mode as Mode, body.data.country.toUpperCase(), body.data.access);
      return modeView(pool);
    } catch (err) {
      if (err instanceof ModeError) return reply.code(statusFor(err.code)).send({ error: err.code });
      return sendErr(reply, err);
    }
  });
}
