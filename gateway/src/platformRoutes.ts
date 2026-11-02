import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { importStatement, liquidityOverview, setExposureCap, setKill, setMarkSource, setProvider, statementBreaks, testProvider } from "./liquidity/admin.js";
import { assignManager, bookCallback, conciergeQueues, recentChat } from "./concierge.js";
import { registerPoolRoutes } from "./poolRoutes.js";
import {
  credit,
  creditsCsv,
  listCredits,
  meta as manualMeta,
  preview as manualPreview,
  reverseCredit,
  searchCustomers,
} from "./manualDeposits.js";
import { backupStatus, todoCounts } from "./opsDesk.js";
import { reconcileBoard, reconcileCsv, reconcileFilter } from "./reconcile.js";
import { addStaffNote, customerCsv, customerProfile, freezeCustomer, searchDirectory } from "./customers.js";
import { listDepositQueue } from "./fundsDesk.js";
import { approveWithdrawal, listWithdrawals, markWithdrawalSent, rejectWithdrawal } from "./withdrawals.js";
import type { Db } from "./db.js";
import { clientIp } from "./geo.js";
import { loadCatalog } from "./instruments.js";
import {
  createInternal,
  deleteInternal,
  internalDetail,
  internalSummary,
  listInternal,
  movePlay,
  setInternalDisabled,
  setInternalPassword,
} from "./play.js";
import { parseScaled } from "./units.js";
import {
  OPENAPI,
  PlatformError,
  RATE_LIMITS,
  addWhitelist,
  assertNotFrozen,
  caseAct,
  caseView,
  changePassword,
  chatInbox,
  claimReferral,
  completeTask,
  decideChange,
  freezeSelf,
  growthView,
  helpSearch,
  ingest,
  listTickets,
  listWhitelist,
  openCase,
  openTicket,
  opsOverview,
  postChat,
  proposeChange,
  replyTicket,
  reports,
  reportsCsv,
  riskDashboard,
  scopeOk,
  searchUsers,
  setPhishing,
  setRule,
  verifySigned,
} from "./platform.js";

type Authed = { id: number; email: string; role: string };

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof PlatformError) {
    return reply.code(err.status).send({
      error: err.code,
      ...(err.code === "PAYMENT_REDACTED"
        ? { warning: "这条消息里有未关联到该客户的收款地址，已拦截。请改用「发送充值地址卡片」。" }
        : {}),
    });
  }
  throw err;
}

export function registerPlatformRoutes(
  app: FastifyInstance,
  deps: {
    pool: Db;
    requireUser: (req: FastifyRequest, reply: FastifyReply) => Promise<Authed | null>;
    allow: (key: string, rate: number, burst: number) => boolean;
    marketBook: (symbol: string) => Promise<unknown>;
    marketTrades: (symbol: string) => Promise<unknown>;
    onChange?: () => Promise<void>;
  },
) {
  const { pool, requireUser, allow, marketBook, marketTrades, onChange } = deps;

  async function role(req: FastifyRequest, reply: FastifyReply, roles: string[]) {
    const user = await requireUser(req, reply);
    if (!user) return null;
    if (!roles.includes(user.role) && user.role !== "admin") {
      reply.code(403).send({ error: "FORBIDDEN" });
      return null;
    }
    return user;
  }

  app.get("/api/security/limits", async () => ({ limits: RATE_LIMITS, csrf: "Origin from a non-local host is rejected on writes.", hibp: process.env.HIBP === "1" ? "live" : "offline-prefix" }));

  app.get("/api/announcements", async () => {
    const rows = await pool.query(
      `SELECT id, title, body, banner FROM announcements WHERE active = true ORDER BY created_at DESC LIMIT 6`,
    );
    return { announcements: rows.rows };
  });

  app.post("/api/account/phishing", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const body = z.object({ code: z.string(), stepUp: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await setPhishing(pool, user.id, body.data.code, body.data.stepUp);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/account/password", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const body = z.object({ current: z.string(), next: z.string(), stepUp: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await changePassword(pool, user.id, body.data.current, body.data.next, body.data.stepUp);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/account/freeze", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const body = z.object({ frozen: z.boolean(), reason: z.string().optional(), stepUp: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await freezeSelf(pool, user.id, body.data.reason ?? "", body.data.stepUp, body.data.frozen);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/account/whitelist", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    return { addresses: await listWhitelist(pool, user.id) };
  });

  app.post("/api/account/whitelist", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const body = z.object({
      asset: z.string(),
      address: z.string(),
      label: z.string().optional(),
      stepUp: z.string().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await addWhitelist(pool, user.id, body.data);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/account/sessions/revoke-others", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const { verifyJwt } = await import("./crypto.js");
    const payload = verifyJwt(token, process.env.JWT_SECRET ?? "<redacted>");
    const sid = payload?.sid ?? "";
    const row = await pool.query(
      `UPDATE sessions SET revoked = true WHERE user_id = $1 AND id <> $2 AND revoked = false RETURNING id`,
      [user.id, sid],
    );
    return { revoked: row.rowCount };
  });

  app.get("/api/account/security", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const me = await pool.query(
      `SELECT frozen, freeze_reason, phishing_code FROM users WHERE id = $1`,
      [user.id],
    );
    const events = await pool.query(
      `SELECT id, kind, detail, created_at FROM security_events WHERE user_id = $1 ORDER BY id DESC LIMIT 20`,
      [user.id],
    );
    return { profile: me.rows[0], events: events.rows, addresses: await listWhitelist(pool, user.id) };
  });

  app.get("/api/admin/risk/dashboard", async (req, reply) => {
    const user = await role(req, reply, ["risk"]);
    if (!user) return;
    return riskDashboard(pool);
  });

  app.post("/api/admin/risk/rules/:id", async (req, reply) => {
    const user = await role(req, reply, ["risk"]);
    if (!user) return;
    const body = z.object({ threshold: z.number().int().positive(), enabled: z.boolean() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await setRule(pool, (req.params as { id: string }).id, body.data.threshold, body.data.enabled);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/admin/risk/observe", async (req, reply) => {
    const user = await role(req, reply, ["risk"]);
    if (!user) return;
    const body = z.object({
      userId: z.number().int(),
      kind: z.string(),
      symbol: z.string().optional(),
      notionalUusd: z.string().optional(),
      refBps: z.number().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    await ingest(pool, {
      userId: body.data.userId,
      kind: body.data.kind,
      symbol: body.data.symbol,
      notionalUusd: body.data.notionalUusd ? BigInt(body.data.notionalUusd) : undefined,
      refBps: body.data.refBps,
    });
    return { ok: true };
  });

  app.post("/api/admin/risk/cases", async (req, reply) => {
    const user = await role(req, reply, ["risk"]);
    if (!user) return;
    const body = z.object({ alertId: z.string().optional(), subjectUserId: z.number().optional(), title: z.string().min(2) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    return openCase(pool, user.id, body.data);
  });

  app.get("/api/admin/risk/cases/:id", async (req, reply) => {
    const user = await role(req, reply, ["risk"]);
    if (!user) return;
    try {
      return await caseView(pool, (req.params as { id: string }).id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/admin/risk/cases/:id", async (req, reply) => {
    const user = await role(req, reply, ["risk"]);
    if (!user) return;
    const body = z.object({ action: z.enum(["assign", "note", "close", "reopen"]), body: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await caseAct(pool, user.id, (req.params as { id: string }).id, body.data.action, body.data.body ?? "");
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/admin/ops/overview", async (req, reply) => {
    const user = await role(req, reply, ["ops"]);
    if (!user) return;
    return opsOverview(pool);
  });

  app.get("/api/admin/ops/users", async (req, reply) => {
    const user = await role(req, reply, ["ops"]);
    if (!user) return;
    const q = String((req.query as { q?: string }).q ?? "");
    return { users: await searchUsers(pool, q) };
  });

  app.get("/api/admin/ops/reports", async (req, reply) => {
    const user = await role(req, reply, ["ops"]);
    if (!user) return;
    return reports(pool);
  });

  app.get("/api/admin/ops/audit", async (req, reply) => {
    const user = await role(req, reply, ["ops"]);
    if (!user) return;
    const rows = await pool.query(
      `SELECT id, user_id, kind, detail, created_at FROM security_events WHERE kind LIKE 'change_%' ORDER BY id DESC LIMIT 30`,
    );
    return { events: rows.rows };
  });

  app.get("/api/admin/ops/reports.csv", async (req, reply) => {
    const user = await role(req, reply, ["ops"]);
    if (!user) return;
    const csv = reportsCsv(await reports(pool));
    reply.header("content-type", "text/csv; charset=utf-8");
    return reply.send(csv);
  });

  app.post("/api/admin/ops/changes", async (req, reply) => {
    const user = await role(req, reply, ["ops"]);
    if (!user) return;
    const body = z.object({ kind: z.string(), payload: z.record(z.unknown()) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await proposeChange(pool, user.id, body.data.kind, body.data.payload);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/admin/ops/changes/:id", async (req, reply) => {
    const user = await role(req, reply, ["ops"]);
    if (!user) return;
    const body = z.object({ action: z.enum(["approve", "reject"]), reason: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      const result = await decideChange(pool, user.id, (req.params as { id: string }).id, body.data.action, body.data.reason ?? "");
      if (body.data.action === "approve") await onChange?.();
      return result;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/growth", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    return growthView(pool, user.id);
  });

  app.post("/api/growth/claim", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const body = z.object({ code: z.string().min(4) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await claimReferral(pool, user.id, body.data.code);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/growth/tasks/:code", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    try {
      return await completeTask(pool, user.id, (req.params as { code: string }).code);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/help", async (req) => {
    const q = String((req.query as { q?: string }).q ?? "");
    return { articles: await helpSearch(pool, q) };
  });

  app.get("/api/support/chat", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const target = user.role === "support" || user.role === "admin"
      ? Number((req.query as { userId?: string }).userId || user.id)
      : user.id;
    return { messages: await recentChat(pool, target) };
  });

  app.get("/api/admin/support/chat", async (req, reply) => {
    const user = await role(req, reply, ["support"]);
    if (!user) return;
    const target = Number((req.query as { userId?: string }).userId || 0);
    if (!target) return reply.code(400).send({ error: "VALIDATION" });
    return { messages: await recentChat(pool, target) };
  });

  app.post("/api/admin/support/chat", async (req, reply) => {
    const user = await role(req, reply, ["support"]);
    if (!user) return;
    const body = z.object({ body: z.string().min(1), userId: z.number() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return { messages: await postChat(pool, body.data.userId, user.id, body.data.body, true, null) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/support/chat", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const body = z.object({
      body: z.string().min(1),
      userId: z.number().optional(),
      topic: z.enum(["deposit"]).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    const staff = user.role === "support" || user.role === "admin";
    const target = staff && body.data.userId ? body.data.userId : user.id;
    try {
      return {
        messages: await postChat(
          pool,
          target,
          user.id,
          body.data.body,
          staff && target !== user.id,
          staff ? null : body.data.topic ?? null,
        ),
      };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/admin/support/inbox", async (req, reply) => {
    const user = await role(req, reply, ["support", "ops", "risk"]);
    if (!user) return;
    return { threads: await chatInbox(pool), tickets: await listTickets(pool, null) };
  });

  app.get("/api/support/tickets", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    if (user.role === "support" || user.role === "admin") return { tickets: await listTickets(pool, null) };
    return { tickets: await listTickets(pool, user.id) };
  });

  app.post("/api/support/tickets", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const body = z.object({ subject: z.string().min(2), body: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    return openTicket(pool, user.id, body.data.subject, body.data.body);
  });

  app.post("/api/support/callbacks", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const body = z.object({
      when: z.string().min(4),
      language: z.enum(["zh", "en", "ms"]),
      phone: z.string().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await bookCallback(pool, user.id, body.data);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/admin/support/queues", async (req, reply) => {
    const user = await role(req, reply, ["support"]);
    if (!user) return;
    return conciergeQueues(pool);
  });

  app.post("/api/admin/support/manager", async (req, reply) => {
    const user = await role(req, reply, ["support"]);
    if (!user) return;
    const body = z.object({
      customerEmail: z.string().email(),
      managerEmail: z.string().email(),
      vip: z.boolean(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await assignManager(pool, user.id, body.data.customerEmail, body.data.managerEmail, body.data.vip);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/support/tickets/:id", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const body = z.object({ body: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    const staff = user.role === "support" || user.role === "admin";
    try {
      return { messages: await replyTicket(pool, (req.params as { id: string }).id, user.id, body.data.body, staff) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/admin/notifications", async (req, reply) => {
    const user = await role(req, reply, ["support", "ops", "risk"]);
    if (!user) return;
    const rows = await pool.query(
      `SELECT n.id, n.channel, n.title, n.body, n.provider, n.status, n.created_at, u.email
       FROM notification_outbox n JOIN users u ON u.id = n.user_id
       ORDER BY n.created_at DESC LIMIT 80`,
    );
    return { messages: rows.rows };
  });

  app.get("/api/notifications", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const rows = await pool.query(
      `SELECT id, channel, title, body, phishing_code, provider, status, created_at
       FROM notification_outbox WHERE user_id = $1 ORDER BY created_at DESC LIMIT 40`,
      [user.id],
    );
    const prefs = await pool.query(
      `SELECT email_on, sms_on, push_on, fills, rejects, announcements FROM notification_prefs WHERE user_id = $1`,
      [user.id],
    );
    return {
      messages: rows.rows,
      prefs: prefs.rows[0] ?? { email_on: true, sms_on: false, push_on: true, fills: true, rejects: true, announcements: true },
    };
  });

  app.post("/api/notifications/prefs", async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const body = z.object({
      emailOn: z.boolean(),
      smsOn: z.boolean(),
      pushOn: z.boolean(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    await pool.query(
      `INSERT INTO notification_prefs (user_id, email_on, sms_on, push_on)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id) DO UPDATE SET email_on = EXCLUDED.email_on, sms_on = EXCLUDED.sms_on, push_on = EXCLUDED.push_on, updated_at = now()`,
      [user.id, body.data.emailOn, body.data.smsOn, body.data.pushOn],
    );
    return { ok: true };
  });

  async function superAdmin(req: FastifyRequest, reply: FastifyReply) {
    const user = await requireUser(req, reply);
    if (!user) return null;
    const flag = await pool.query(`SELECT address_pool_owner FROM users WHERE id = $1`, [user.id]);
    if (!flag.rows[0]?.address_pool_owner) {
      reply.code(403).send({ error: "FORBIDDEN" });
      return null;
    }
    return user;
  }

  app.get("/api/admin/internal-test", async (req, reply) => {
    const user = await superAdmin(req, reply);
    if (!user) return;
    return { badge: "INTERNAL TEST / 内部测试", accounts: await listInternal(pool), summary: await internalSummary(pool) };
  });

  app.get("/api/admin/internal-test/:id", async (req, reply) => {
    const user = await superAdmin(req, reply);
    if (!user) return;
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await internalDetail(pool, id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/admin/internal-test", async (req, reply) => {
    const user = await superAdmin(req, reply);
    if (!user) return;
    const body = z.object({
      email: z.string().email(),
      name: z.string().min(1).max(80),
      password: z.string().min(8).max(200),
      totp: z.boolean().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await createInternal(pool, user.id, {
        email: body.data.email,
        name: body.data.name,
        password: body.data.password,
        totp: Boolean(body.data.totp),
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/admin/internal-test/:id/password", async (req, reply) => {
    const user = await superAdmin(req, reply);
    if (!user) return;
    const id = Number((req.params as { id: string }).id);
    const body = z.object({ password: z.string().min(8).max(200) }).safeParse(req.body);
    if (!Number.isInteger(id) || !body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await setInternalPassword(pool, user.id, id, body.data.password);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/admin/internal-test/:id/disabled", async (req, reply) => {
    const user = await superAdmin(req, reply);
    if (!user) return;
    const id = Number((req.params as { id: string }).id);
    const body = z.object({ disabled: z.boolean() }).safeParse(req.body);
    if (!Number.isInteger(id) || !body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await setInternalDisabled(pool, user.id, id, body.data.disabled);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete("/api/admin/internal-test/:id", async (req, reply) => {
    const user = await superAdmin(req, reply);
    if (!user) return;
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await deleteInternal(pool, user.id, id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/admin/internal-test/:id/move", async (req, reply) => {
    const user = await superAdmin(req, reply);
    if (!user) return;
    const id = Number((req.params as { id: string }).id);
    const body = z.object({
      direction: z.enum(["credit", "debit"]),
      asset: z.string().min(2).max(12),
      amount: z.string(),
      reason: z.string().min(3).max(180),
    }).safeParse(req.body);
    if (!Number.isInteger(id) || !body.success) return reply.code(400).send({ error: "VALIDATION" });
    const asset = body.data.asset.toUpperCase();
    const inst = asset === "USD" ? null : loadCatalog().find((row) => row.base === asset && row.quote === "USD");
    const scale = asset === "USD" ? 6 : inst?.qtyDecimals;
    if (scale == null) return reply.code(400).send({ error: "VALIDATION" });
    try {
      const amount = parseScaled(body.data.amount, scale);
      return await movePlay(pool, user.id, id, { direction: body.data.direction, asset, amount, reason: body.data.reason });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/openapi.json", async () => OPENAPI);

  app.get("/api/v1/market/book", async (req) => {
    const symbol = ((req.query as { symbol?: string }).symbol || "XAU/USD").toUpperCase();
    return marketBook(symbol);
  });

  app.get("/api/v1/market/trades", async (req) => {
    const symbol = ((req.query as { symbol?: string }).symbol || "XAU/USD").toUpperCase();
    return marketTrades(symbol);
  });

  app.get("/api/v1/balances", async (req, reply) => {
    const auth = await signed(req, reply, "read");
    if (!auth) return;
    return balancesForUser(pool, auth.userId);
  });

  async function signed(req: FastifyRequest, reply: FastifyReply, need: "read" | "trade") {
    if (!allow(`v1:${req.headers["x-api-key"] ?? clientIp(req)}`, 8, 16)) {
      reply.code(429).send({ error: "RATE_LIMITED" });
      return null;
    }
    const keyId = String(req.headers["x-api-key"] ?? "");
    const ts = String(req.headers["x-api-timestamp"] ?? "");
    const signature = String(req.headers["x-api-sign"] ?? "");
    if (!keyId || !ts || !signature) {
      reply.code(401).send({ error: "SIGNATURE" });
      return null;
    }
    const url = new URL(req.url, "http://localhost");
    const path = `${url.pathname}${url.search}`;
    const body = typeof req.body === "string" ? req.body : req.body ? JSON.stringify(req.body) : "";
    try {
      const auth = await verifySigned(pool, { keyId, ts, signature, method: req.method, path, body, ip: clientIp(req) });
      if (!scopeOk(auth.scopes, need)) {
        reply.code(403).send({ error: "SCOPE_DENIED" });
        return null;
      }
      await assertNotFrozen(pool, auth.userId);
      return auth;
    } catch (err) {
      if (err instanceof PlatformError) {
        reply.code(err.status).send({ error: err.code });
        return null;
      }
      throw err;
    }
  }

  app.post("/api/v1/orders", async (req, reply) => {
    const auth = await signed(req, reply, "trade");
    if (!auth) return;
    return reply.code(400).send({ error: "VALIDATION", note: "Use the desk ticket for a live order. Scope check passed." });
  });

  async function creditor(req: FastifyRequest, reply: FastifyReply) {
    const user = await requireUser(req, reply);
    if (!user) return null;
    if (user.role === "ops") return user;
    const flag = await pool.query(`SELECT address_pool_owner FROM users WHERE id = $1`, [user.id]);
    if (!flag.rows[0]?.address_pool_owner) {
      reply.code(403).send({ error: "FORBIDDEN" });
      return null;
    }
    return user;
  }

  app.get("/api/admin/manual-deposits/meta", async (req, reply) => {
    const user = await creditor(req, reply);
    if (!user) return;
    return manualMeta(pool);
  });

  app.get("/api/admin/manual-deposits/customers", async (req, reply) => {
    const user = await creditor(req, reply);
    if (!user) return;
    const q = String((req.query as { q?: string }).q ?? "");
    try {
      return await searchCustomers(pool, user, q);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/admin/manual-deposits/preview", async (req, reply) => {
    const user = await creditor(req, reply);
    if (!user) return;
    const query = req.query as { userId?: string; asset?: string; network?: string; amount?: string };
    const userId = Number(query.userId);
    if (!query.asset || !query.network || !Number.isInteger(userId)) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await manualPreview(pool, user, { userId, asset: query.asset, network: query.network, amount: query.amount });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/admin/manual-deposits.csv", async (req, reply) => {
    const user = await creditor(req, reply);
    if (!user) return;
    const q = String((req.query as { q?: string }).q ?? "");
    try {
      const csv = await creditsCsv(pool, user, q);
      return reply.header("content-type", "text/csv; charset=utf-8").send(csv);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/admin/manual-deposits", async (req, reply) => {
    const user = await creditor(req, reply);
    if (!user) return;
    const q = String((req.query as { q?: string }).q ?? "");
    try {
      return { credits: await listCredits(pool, user, q) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/admin/manual-deposits", async (req, reply) => {
    const user = await creditor(req, reply);
    if (!user) return;
    const body = z.object({
      userId: z.number().int().positive(),
      asset: z.string().min(1).max(12),
      network: z.string().min(1).max(32),
      amount: z.string().min(1).max(40),
      reference: z.string().min(1).max(128),
      receivedAt: z.string().min(1).max(40),
      note: z.string().max(500).optional().nullable(),
      screenshotUrl: z.string().max(400).optional().nullable(),
      totp: z.string().optional(),
      confirm: z.boolean().optional(),
      claimId: z.number().int().positive().optional().nullable(),
      txHash: z.string().max(128).optional().nullable(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await credit(pool, user, body.data);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/admin/manual-deposits/:id/reverse", async (req, reply) => {
    const user = await superAdmin(req, reply);
    if (!user) return;
    const id = Number((req.params as { id: string }).id);
    const body = z.object({
      reason: z.string().min(3).max(240),
      totp: z.string().optional(),
    }).safeParse(req.body);
    if (!body.success || !Number.isInteger(id)) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await reverseCredit(pool, user, id, body.data.reason, body.data.totp);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/admin/funds/deposits", async (req, reply) => {
    const user = await role(req, reply, ["ops", "support", "risk"]);
    if (!user) return;
    const query = req.query as { status?: string; q?: string };
    return { deposits: await listDepositQueue(pool, String(query.status ?? "pending"), String(query.q ?? "")) };
  });

  app.get("/api/admin/funds/withdrawals", async (req, reply) => {
    const user = await role(req, reply, ["ops", "support", "risk"]);
    if (!user) return;
    const query = req.query as { status?: string; q?: string };
    return { withdrawals: await listWithdrawals(pool, String(query.status ?? "pending"), String(query.q ?? "")) };
  });

  app.get("/api/admin/withdrawals", async (req, reply) => {
    const user = await role(req, reply, ["ops", "support", "risk"]);
    if (!user) return;
    const query = req.query as { status?: string; q?: string };
    const status = String(query.status ?? "pending");
    return { withdrawals: await listWithdrawals(pool, status, String(query.q ?? "")) };
  });

  app.post("/api/admin/withdrawals/:id/approve", async (req, reply) => {
    const user = await superAdmin(req, reply);
    if (!user) return;
    const id = Number((req.params as { id: string }).id);
    const body = z.object({ totp: z.string().optional() }).safeParse(req.body ?? {});
    if (!body.success || !Number.isInteger(id)) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await approveWithdrawal(pool, user.id, id, body.data.totp);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/admin/withdrawals/:id/sent", async (req, reply) => {
    const user = await superAdmin(req, reply);
    if (!user) return;
    const id = Number((req.params as { id: string }).id);
    const body = z.object({
      totp: z.string().optional(),
      txHash: z.string().min(4).max(128),
    }).safeParse(req.body ?? {});
    if (!body.success || !Number.isInteger(id)) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await markWithdrawalSent(pool, user.id, id, body.data.totp, body.data.txHash);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/admin/withdrawals/:id/reject", async (req, reply) => {
    const user = await superAdmin(req, reply);
    if (!user) return;
    const id = Number((req.params as { id: string }).id);
    const body = z.object({
      totp: z.string().optional(),
      reason: z.string().min(1).max(180),
    }).safeParse(req.body ?? {});
    if (!body.success || !Number.isInteger(id)) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await rejectWithdrawal(pool, user.id, id, body.data.totp, body.data.reason);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/admin/deposits/reconcile.csv", async (req, reply) => {
    const user = await role(req, reply, ["ops", "support", "risk"]);
    if (!user) return;
    const filter = reconcileFilter(String((req.query as { filter?: string }).filter ?? "today"));
    const csv = reconcileCsv(await reconcileBoard(pool, filter));
    reply.header("content-type", "text/csv; charset=utf-8");
    return reply.send(csv);
  });

  app.get("/api/admin/deposits/reconcile", async (req, reply) => {
    const user = await role(req, reply, ["ops", "support", "risk"]);
    if (!user) return;
    const filter = reconcileFilter(String((req.query as { filter?: string }).filter ?? "today"));
    return { filter, rows: await reconcileBoard(pool, filter) };
  });

  app.get("/api/admin/backup", async (req, reply) => {
    const user = await role(req, reply, ["ops", "support", "risk"]);
    if (!user) return;
    return backupStatus();
  });

  app.get("/api/admin/customers", async (req, reply) => {
    const user = await role(req, reply, ["ops", "support", "risk"]);
    if (!user) return;
    const q = String((req.query as { q?: string }).q ?? "");
    await pool.query(`INSERT INTO security_events (user_id, kind, detail) VALUES ($1,'customer_search',$2)`, [
      user.id,
      q.trim().slice(0, 120),
    ]);
    return { customers: await searchDirectory(pool, q) };
  });

  app.get("/api/admin/customers/:id/deposits.csv", async (req, reply) => {
    const user = await role(req, reply, ["ops", "support", "risk"]);
    if (!user) return;
    try {
      const file = await customerCsv(pool, user, (req.params as { id: string }).id, "deposits");
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="${file.filename}"`)
        .send(file.csv);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/admin/customers/:id/withdrawals.csv", async (req, reply) => {
    const user = await role(req, reply, ["ops", "support", "risk"]);
    if (!user) return;
    try {
      const file = await customerCsv(pool, user, (req.params as { id: string }).id, "withdrawals");
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="${file.filename}"`)
        .send(file.csv);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/admin/customers/:id", async (req, reply) => {
    const user = await role(req, reply, ["ops", "support", "risk"]);
    if (!user) return;
    try {
      return await customerProfile(pool, user, (req.params as { id: string }).id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/admin/customers/:id/notes", async (req, reply) => {
    const user = await role(req, reply, ["ops", "support", "risk"]);
    if (!user) return;
    const body = z.object({ body: z.string().min(1).max(2000) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await addStaffNote(pool, user, (req.params as { id: string }).id, body.data.body);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/admin/customers/:id/freeze", async (req, reply) => {
    const user = await superAdmin(req, reply);
    if (!user) return;
    const body = z.object({
      frozen: z.boolean(),
      reason: z.string().max(180).optional(),
      totp: z.string().optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await freezeCustomer(pool, user, (req.params as { id: string }).id, body.data.frozen, body.data.reason ?? "", body.data.totp);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/admin/todo", async (req, reply) => {
    const user = await role(req, reply, ["ops", "support", "risk"]);
    if (!user) return;
    return todoCounts(pool);
  });

  app.get("/api/admin/liquidity", async (req, reply) => {
    const user = await role(req, reply, ["ops", "support", "risk"]);
    if (!user) return;
    return liquidityOverview(pool);
  });

  app.get("/api/admin/liquidity/statements", async (req, reply) => {
    const user = await role(req, reply, ["ops"]);
    if (!user) return;
    return { rows: await statementBreaks(pool) };
  });

  app.post("/api/admin/liquidity/providers/:id/test", async (req, reply) => {
    const user = await role(req, reply, ["ops", "support", "risk"]);
    if (!user) return;
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await testProvider(pool, id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/admin/liquidity/providers/:id", async (req, reply) => {
    const user = await superAdmin(req, reply);
    if (!user) return;
    const id = Number((req.params as { id: string }).id);
    const body = z.object({
      mode: z.enum(["off", "shadow", "live"]),
      enabled: z.boolean(),
      spreadMarkupBps: z.number().int(),
      minQty: z.string(),
      maxQty: z.string(),
      perOrderNotionalUusd: z.string(),
      dailyNotionalUusd: z.string(),
      priority: z.number().int(),
      symbolMap: z.record(z.string(), z.string()).default({}),
      baseUrl: z.string().default(""),
      totp: z.string().optional(),
    }).safeParse(req.body);
    if (!body.success || !Number.isInteger(id)) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await setProvider(pool, user, id, body.data);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/admin/liquidity/kill", async (req, reply) => {
    const user = await superAdmin(req, reply);
    if (!user) return;
    const body = z.object({ stopped: z.boolean(), totp: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await setKill(pool, user, body.data.stopped, body.data.totp);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/admin/liquidity/marks/:id", async (req, reply) => {
    const user = await superAdmin(req, reply);
    if (!user) return;
    const id = (req.params as { id: string }).id;
    const body = z.object({ enabled: z.boolean(), totp: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await setMarkSource(pool, user, id, body.data.enabled, body.data.totp);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/admin/liquidity/exposure", async (req, reply) => {
    const user = await superAdmin(req, reply);
    if (!user) return;
    const body = z.object({ asset: z.string(), maxAbsQty: z.string(), totp: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await setExposureCap(pool, user, body.data.asset, body.data.maxAbsQty, body.data.totp);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/admin/liquidity/statements", async (req, reply) => {
    const user = await role(req, reply, ["ops"]);
    if (!user) return;
    const body = z.object({ providerId: z.number().int(), csv: z.string().max(200_000) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      const result = await importStatement(pool, body.data.providerId, body.data.csv);
      return result;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  registerPoolRoutes(app, { pool, requireUser });

  app.post("/api/v1/withdraw", async (req, reply) => {
    const keyId = String(req.headers["x-api-key"] ?? "");
    const ts = String(req.headers["x-api-timestamp"] ?? "");
    const signature = String(req.headers["x-api-sign"] ?? "");
    const url = new URL(req.url, "http://localhost");
    const path = `${url.pathname}${url.search}`;
    const body = req.body ? JSON.stringify(req.body) : "";
    try {
      const auth = await verifySigned(pool, { keyId, ts, signature, method: req.method, path, body, ip: clientIp(req) });
      if (!scopeOk(auth.scopes, "withdraw")) return reply.code(403).send({ error: "SCOPE_DENIED" });
      return reply.code(403).send({ error: "SCOPE_DENIED" });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}

export async function balancesForUser(pool: Db, userId: number) {
  const rows = await pool.query(
    `SELECT a.asset, a.bucket, b.amount::text
     FROM accounts a JOIN balances b ON b.account_id = a.id
     WHERE a.customer_id = $1 AND a.bucket IN ('available', 'reserved', 'withdraw_hold')`,
    [userId],
  );
  return { balances: rows.rows };
}
