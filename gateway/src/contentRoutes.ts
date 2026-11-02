import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "./db.js";
import { PlatformError } from "./errors.js";
import {
  adminContent,
  contentAudit,
  publicContent,
  resetNumber,
  resetString,
  saveAnnouncement,
  setNumber,
  setString,
} from "./content.js";

type Authed = { id: number; email: string; role: string };

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof PlatformError) return reply.code(err.status).send({ error: err.code });
  throw err;
}

export function registerContentRoutes(
  app: FastifyInstance,
  deps: { pool: Db; requireUser: (req: FastifyRequest, reply: FastifyReply) => Promise<Authed | null> },
) {
  const { pool, requireUser } = deps;

  app.get("/api/content", async (_req, reply) => {
    reply.header("cache-control", "public, max-age=2");
    return publicContent(pool);
  });

  async function admin(req: FastifyRequest, reply: FastifyReply) {
    const user = await requireUser(req, reply);
    if (!user) return null;
    if (user.role !== "admin") {
      reply.code(403).send({ error: "FORBIDDEN" });
      return null;
    }
    return user;
  }

  app.get("/api/admin/content", async (req, reply) => {
    const user = await admin(req, reply);
    if (!user) return;
    return adminContent(pool);
  });

  app.get("/api/admin/content/audit", async (req, reply) => {
    const user = await admin(req, reply);
    if (!user) return;
    return { events: await contentAudit(pool) };
  });

  app.put("/api/admin/content/string", async (req, reply) => {
    const user = await admin(req, reply);
    if (!user) return;
    const body = z.object({ key: z.string().min(1).max(180), value: z.string().max(4000) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await setString(pool, user.id, body.data.key, body.data.value);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete("/api/admin/content/string", async (req, reply) => {
    const user = await admin(req, reply);
    if (!user) return;
    const body = z.object({ key: z.string().min(1).max(180) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await resetString(pool, user.id, body.data.key);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put("/api/admin/content/number", async (req, reply) => {
    const user = await admin(req, reply);
    if (!user) return;
    const body = z.object({ key: z.string(), value: z.number(), totp: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await setNumber(pool, user.id, body.data.key, body.data.value, body.data.totp);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete("/api/admin/content/number", async (req, reply) => {
    const user = await admin(req, reply);
    if (!user) return;
    const body = z.object({ key: z.string(), totp: z.string().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await resetNumber(pool, user.id, body.data.key, body.data.totp);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/admin/content/announcement", async (req, reply) => {
    const user = await admin(req, reply);
    if (!user) return;
    const body = z
      .object({
        id: z.string().optional(),
        title: z.string(),
        body: z.string(),
        banner: z.boolean(),
        active: z.boolean(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "VALIDATION" });
    try {
      return await saveAnnouncement(pool, user.id, body.data);
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
