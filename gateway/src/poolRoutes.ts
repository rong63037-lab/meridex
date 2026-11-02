import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "./db.js";
import { clientIp } from "./geo.js";
import { PlatformError } from "./errors.js";
import {
  assertPoolOwner,
  assignSpecific,
  attributeAddress,
  confirmTotpEnrol,
  deletePoolAddress,
  editPoolAddress,
  importAddresses,
  listPool,
  previewAddresses,
  listPoolAudit,
  requireFreshTotp,
  retirePoolAddress,
  setThreshold,
  startTotpEnrol,
} from "./pool.js";
import { lookupDeposits, sendDepositCard, sendStatusCard } from "./concierge.js";

type Authed = { id: number; email: string; role: string };

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof PlatformError) {
    const warning =
      err.code === "PAYMENT_REDACTED"
        ? "这条消息里有未关联到该客户的收款地址，已拦截。请改用「发送充值地址卡片」。"
        : undefined;
    return reply.code(err.status).send({ error: err.code, ...(warning ? { warning } : {}) });
  }
  throw err;
}

export function registerPoolRoutes(
  app: FastifyInstance,
  deps: {
    pool: Db;
    requireUser: (req: FastifyRequest, reply: FastifyReply) => Promise<Authed | null>;
  },
) {
  const { pool, requireUser } = deps;

  async function staff(req: FastifyRequest, reply: FastifyReply) {
    const user = await requireUser(req, reply);
    if (!user) return null;
    if (!["admin", "risk", "ops", "support"].includes(user.role)) {
      reply.code(403).send({ error: "FORBIDDEN" });
      return null;
    }
    return user;
  }

  async function owner(req: FastifyRequest, reply: FastifyReply) {
    const user = await staff(req, reply);
    if (!user) return null;
    try {
      await assertPoolOwner(pool, user.id);
    } catch (err) {
      sendError(reply, err);
      return null;
    }
    return user;
  }

  app.get("/api/admin/treasury/pool", async (req, reply) => {
    const user = await staff(req, reply);
    if (!user) return;
    const flag = await pool.query(`SELECT address_pool_owner FROM users WHERE id = $1`, [user.id]);
    return listPool(pool, Boolean(flag.rows[0]?.address_pool_owner));
  });

  app.get("/api/admin/treasury/audit", async (req, reply) => {
    const user = await staff(req, reply);
    if (!user) return;
    return { events: await listPoolAudit(pool) };
  });

  app.get("/api/admin/treasury/attribute", async (req, reply) => {
    const user = await staff(req, reply);
    if (!user) return;
    const address = String((req.query as { address?: string }).address ?? "");
    if (address.length < 8) return reply.code(400).send({ error: "VALIDATION" });
    return { matches: await attributeAddress(pool, address) };
  });

  for (const name of ["import", "edit", "retire", "delete", "assign", "threshold"]) {
    app.post(`/api/admin/treasury/pool/${name}`, async (_req, reply) => {
      return reply.code(403).send({ error: "POOL_DESK" });
    });
  }

  app.get("/api/pool/treasury/pool", async (req, reply) => {
    const user = await owner(req, reply);
    if (!user) return;
    return listPool(pool, true);
  });

  app.get("/api/pool/treasury/audit", async (req, reply) => {
    const user = await owner(req, reply);
    if (!user) return;
    return { events: await listPoolAudit(pool) };
  });

  app.post("/api/pool/treasury/pool/preview", async (req, reply) => {
    const user = await owner(req, reply);
    if (!user) return;
    const body = z.object({
      rows: z.array(z.object({
        line: z.number().optional(),
        asset: z.string().optional(),
        network: z.string().optional(),
        address: z.string(),
      })).max(200),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await previewAddresses(pool, body.data.rows);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/pool/treasury/pool/import", async (req, reply) => {
    const user = await owner(req, reply);
    if (!user) return;
    const body = z.object({
      totp: z.string().optional(),
      csv: z.string().optional(),
      rows: z.array(z.object({
        asset: z.string(),
        network: z.string(),
        address: z.string(),
        memo: z.string().optional(),
        min: z.string().optional(),
      })).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      await requireFreshTotp(pool, user.id, body.data.totp);
      const rows = body.data.rows?.length ? body.data.rows : parseCsv(body.data.csv ?? "");
      return await importAddresses(pool, user.id, clientIp(req), rows);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/pool/treasury/pool/edit", async (req, reply) => {
    const user = await owner(req, reply);
    if (!user) return;
    const body = z.object({ totp: z.string().optional(), id: z.number(), address: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      await requireFreshTotp(pool, user.id, body.data.totp);
      return await editPoolAddress(pool, user.id, clientIp(req), body.data.id, body.data.address);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/pool/treasury/pool/retire", async (req, reply) => {
    const user = await owner(req, reply);
    if (!user) return;
    const body = z.object({ totp: z.string().optional(), id: z.number() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      await requireFreshTotp(pool, user.id, body.data.totp);
      return await retirePoolAddress(pool, user.id, clientIp(req), body.data.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/pool/treasury/pool/delete", async (req, reply) => {
    const user = await owner(req, reply);
    if (!user) return;
    const body = z.object({ totp: z.string().optional(), id: z.number() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      await requireFreshTotp(pool, user.id, body.data.totp);
      return await deletePoolAddress(pool, user.id, clientIp(req), body.data.id);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/pool/treasury/pool/assign", async (req, reply) => {
    const user = await owner(req, reply);
    if (!user) return;
    const body = z.object({ totp: z.string().optional(), id: z.number(), customerEmail: z.string().email() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      await requireFreshTotp(pool, user.id, body.data.totp);
      return await assignSpecific(pool, user.id, clientIp(req), body.data.id, body.data.customerEmail);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/pool/treasury/pool/threshold", async (req, reply) => {
    const user = await owner(req, reply);
    if (!user) return;
    const body = z.object({ totp: z.string().optional(), asset: z.string(), network: z.string(), threshold: z.number() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      await requireFreshTotp(pool, user.id, body.data.totp);
      return await setThreshold(pool, user.id, clientIp(req), body.data.asset, body.data.network, body.data.threshold);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/admin/security/totp/start", async (req, reply) => {
    const user = await staff(req, reply);
    if (!user) return;
    const body = z.object({ totp: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await startTotpEnrol(pool, user.id, body.data.totp);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/admin/security/totp/confirm", async (req, reply) => {
    const user = await staff(req, reply);
    if (!user) return;
    const body = z.object({ totp: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await confirmTotpEnrol(pool, user.id, body.data.totp);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/admin/support/deposit-card", async (req, reply) => {
    const user = await staff(req, reply);
    if (!user) return;
    if (user.role !== "support" && user.role !== "admin") return reply.code(403).send({ error: "FORBIDDEN" });
    const raw = (req.body ?? {}) as Record<string, unknown>;
    if ("address" in raw) return reply.code(400).send({ error: "ADDRESS_NOT_ACCEPTED" });
    const body = z.object({ userId: z.number(), asset: z.string(), network: z.string() }).safeParse(raw);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return { messages: await sendDepositCard(pool, user.id, body.data.userId, body.data.asset, body.data.network, clientIp(req)) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/admin/support/deposit-status-card", async (req, reply) => {
    const user = await staff(req, reply);
    if (!user) return;
    if (user.role !== "support" && user.role !== "admin") return reply.code(403).send({ error: "FORBIDDEN" });
    const body = z.object({ userId: z.number(), depositId: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return { messages: await sendStatusCard(pool, user.id, body.data.userId, body.data.depositId) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get("/api/admin/support/deposits", async (req, reply) => {
    const user = await staff(req, reply);
    if (!user) return;
    if (user.role !== "support" && user.role !== "admin") return reply.code(403).send({ error: "FORBIDDEN" });
    try {
      return await lookupDeposits(pool, String((req.query as { q?: string }).q ?? ""));
    } catch (err) {
      return sendError(reply, err);
    }
  });
}

function parseCsv(csv: string) {
  const lines = csv.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    const [asset, network, address, memo, min] = line.split(",").map((part) => part.trim());
    if (!asset || asset.toLowerCase() === "asset") continue;
    rows.push({ asset, network: network ?? "", address: address ?? "", memo, min });
  }
  return rows;
}
