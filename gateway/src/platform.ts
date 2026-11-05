import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { hashPassword, verifyPassword, verifyTotp } from "./crypto.js";
import { applyBulk, assertBulk, CoverageError } from "./coverage.js";
import { recentChat, recordPaymentBlock, screenStaffMessage } from "./concierge.js";
import { seedAddressPool } from "./pool.js";
import type { Db } from "./db.js";
import { PlatformError } from "./errors.js";

export { PlatformError };

export const RATE_LIMITS = [
  { route: "POST /api/auth/login", perSec: 3, burst: 8, note: "Credential stuffing" },
  { route: "POST /api/auth/register", perSec: 2, burst: 5, note: "Signup flood" },
  { route: "POST /api/orders", perSec: 8, burst: 16, note: "Order entry" },
  { route: "POST /api/wallet/withdraw", perSec: 0.2, burst: 2, note: "Withdrawal velocity" },
  { route: "POST /api/v1/* signed", perSec: 8, burst: 16, note: "Per API key" },
] as const;

const LOCK_MS = () => Number(process.env.WHITELIST_LOCK_MS ?? 24 * 60 * 60 * 1000);

export function deviceLabel(ua: string | null): string {
  if (!ua) return "unknown";
  if (/iPhone|iPad/i.test(ua)) return "iOS";
  if (/Android/i.test(ua)) return "Android";
  if (/Mac OS/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Linux/i.test(ua)) return "Linux";
  return "browser";
}

export function passwordIssues(password: string): string | null {
  if (password.length < 10 || password.length > 100) return "WEAK_PASSWORD";
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    return "WEAK_PASSWORD";
  }
  return null;
}

function sha1Parts(password: string): { prefix: string; suffix: string } {
  const hex = createHash("sha1").update(password).digest("hex").toUpperCase();
  return { prefix: hex.slice(0, 5), suffix: hex.slice(5) };
}

export async function passwordBreached(pool: Db, password: string): Promise<boolean> {
  const { prefix, suffix } = sha1Parts(password);
  const local = await pool.query(`SELECT 1 FROM password_breaches WHERE prefix = $1 AND suffix = $2`, [prefix, suffix]);
  if (local.rowCount) return true;
  if (process.env.HIBP !== "1") return false;
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { "Add-Padding": "true" },
    });
    if (!res.ok) return false;
    const text = await res.text();
    return text.split("\n").some((line) => line.trim().toUpperCase().startsWith(suffix));
  } catch {
    return false;
  }
}

export async function assertPassword(pool: Db, password: string): Promise<void> {
  const weak = passwordIssues(password);
  if (weak) throw new PlatformError(weak, 400);
  if (await passwordBreached(pool, password)) throw new PlatformError("BREACHED_PASSWORD", 400);
}

export async function requireStepUp(pool: Db, userId: number, code: string | undefined): Promise<void> {
  if (!code) throw new PlatformError("STEP_UP_REQUIRED", 401);
  const row = await pool.query(`SELECT totp_secret FROM users WHERE id = $1`, [userId]);
  if (!row.rowCount || !verifyTotp(row.rows[0].totp_secret as string, code)) {
    throw new PlatformError("INVALID_TOTP", 401);
  }
}

export async function assertNotFrozen(pool: Db, userId: number): Promise<void> {
  const row = await pool.query(`SELECT frozen FROM users WHERE id = $1`, [userId]);
  if (row.rows[0]?.frozen) throw new PlatformError("ACCOUNT_FROZEN", 403);
}

async function audit(pool: Db, userId: number, kind: string, detail: string) {
  await pool.query(`INSERT INTO security_events (user_id, kind, detail) VALUES ($1,$2,$3)`, [userId, kind, detail]);
}

export async function enqueueNotice(
  pool: Db,
  userId: number,
  channel: "email" | "sms" | "push" | "inapp",
  title: string,
  body: string,
) {
  const prefs = await pool.query(
    `SELECT email_on, sms_on, push_on FROM notification_prefs WHERE user_id = $1`,
    [userId],
  );
  const pref = prefs.rows[0] as { email_on: boolean; sms_on: boolean; push_on: boolean } | undefined;
  const security = title.startsWith("安全") || title.startsWith("MERIDEX · 安全");
  if (!security && pref) {
    if (channel === "email" && pref.email_on === false) return;
    if (channel === "sms" && pref.sms_on === false) return;
    if (channel === "push" && pref.push_on === false) return;
  }
  const codeRow = await pool.query(`SELECT phishing_code FROM users WHERE id = $1`, [userId]);
  const code = (codeRow.rows[0]?.phishing_code as string | null) ?? null;
  const stamped = code ? `${body}\n防钓鱼码 ${code}` : body;
  const provider = channel === "email" ? "mock-email" : channel === "sms" ? "mock-sms" : channel === "push" ? "mock-push" : "inapp";
  await pool.query(
    `INSERT INTO notification_outbox (id, user_id, channel, title, body, phishing_code, provider, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'mock_sent')`,
    [crypto.randomUUID(), userId, channel, title, stamped, code, provider],
  );
}

export async function setPhishing(pool: Db, userId: number, code: string, stepUp: string | undefined) {
  await requireStepUp(pool, userId, stepUp);
  if (!/^[A-Za-z0-9]{4,12}$/.test(code)) throw new PlatformError("VALIDATION");
  await pool.query(`UPDATE users SET phishing_code = $2 WHERE id = $1`, [userId, code]);
  await audit(pool, userId, "phishing", "防钓鱼码已更新");
  await enqueueNotice(pool, userId, "email", "MERIDEX · 安全 · 防钓鱼码", "美瑞德通知。你的通知里以后会带上这组防钓鱼码。");
  return { code };
}

export async function changePassword(
  pool: Db,
  userId: number,
  current: string,
  next: string,
  stepUp: string | undefined,
) {
  await requireStepUp(pool, userId, stepUp);
  const row = await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [userId]);
  if (!row.rowCount || !verifyPassword(current, row.rows[0].password_hash as string)) {
    throw new PlatformError("INVALID_CREDENTIALS", 401);
  }
  await assertPassword(pool, next);
  await pool.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [userId, hashPassword(next)]);
  await audit(pool, userId, "password", "密码已更换");
  await enqueueNotice(pool, userId, "email", "MERIDEX · 安全 · 密码已更换", "美瑞德通知。如果不是你本人操作，请冻结账户。");
  return { ok: true };
}

export async function freezeSelf(pool: Db, userId: number, reason: string, stepUp: string | undefined, frozen: boolean) {
  await requireStepUp(pool, userId, stepUp);
  await pool.query(`UPDATE users SET frozen = $2, freeze_reason = $3 WHERE id = $1`, [
    userId,
    frozen,
    frozen ? reason.slice(0, 180) : null,
  ]);
  await audit(pool, userId, frozen ? "freeze" : "unfreeze", reason.slice(0, 180));
  await enqueueNotice(pool, userId, "email", frozen ? "MERIDEX · 安全 · 账户已冻结" : "MERIDEX · 安全 · 账户已解冻", reason.slice(0, 180) || "美瑞德通知。自助操作");
  return { frozen };
}

export async function addWhitelist(
  pool: Db,
  userId: number,
  input: { asset: string; address: string; label?: string; stepUp?: string },
) {
  await requireStepUp(pool, userId, input.stepUp);
  const asset = input.asset.toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(asset) || input.address.trim().length < 8) throw new PlatformError("VALIDATION");
  const id = crypto.randomUUID();
  const unlock = new Date(Date.now() + LOCK_MS());
  await pool.query(
    `INSERT INTO withdrawal_addresses (id, user_id, asset, address, label, status, unlock_at)
     VALUES ($1,$2,$3,$4,$5,'locked',$6)`,
    [id, userId, asset, input.address.trim().slice(0, 120), (input.label ?? "").slice(0, 40), unlock.toISOString()],
  );
  await audit(pool, userId, "whitelist", `${asset} 新地址进入 24 小时锁`);
  await enqueueNotice(pool, userId, "email", "MERIDEX · 安全 · 出金地址待解锁", `美瑞德通知。${asset} 地址已登记，锁定期结束前不能出金。`);
  return { id, status: "locked", unlockAt: unlock.toISOString() };
}

export async function listWhitelist(pool: Db, userId: number) {
  const rows = await pool.query(
    `SELECT id, asset, address, label, status, unlock_at, created_at
     FROM withdrawal_addresses WHERE user_id = $1 AND status <> 'removed' ORDER BY created_at DESC`,
    [userId],
  );
  const now = Date.now();
  return rows.rows.map((row) => ({
    ...row,
    status: row.status === "locked" && new Date(row.unlock_at as string).getTime() <= now ? "active" : row.status,
  }));
}

export async function assertWhitelist(pool: Db, userId: number, asset: string, address: string) {
  await pool.query(
    `UPDATE withdrawal_addresses SET status = 'active'
     WHERE user_id = $1 AND status = 'locked' AND unlock_at <= now()`,
    [userId],
  );
  const row = await pool.query(
    `SELECT status, unlock_at FROM withdrawal_addresses
     WHERE user_id = $1 AND asset = $2 AND address = $3 AND status <> 'removed'
     ORDER BY created_at DESC LIMIT 1`,
    [userId, asset.toUpperCase(), address.trim()],
  );
  if (!row.rowCount) throw new PlatformError("WHITELIST_REQUIRED", 403);
  if (row.rows[0].status !== "active") throw new PlatformError("WHITELIST_LOCKED", 403);
}

export function signV1(secret: string, ts: string, method: string, path: string, body: string): string {
  const hash = createHash("sha256").update(body).digest("hex");
  const payload = `${ts}\n${method.toUpperCase()}\n${path}\n${hash}`;
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export async function verifySigned(
  pool: Db,
  input: { keyId: string; ts: string; signature: string; method: string; path: string; body: string; ip: string | null },
): Promise<{ userId: number; scopes: string[] }> {
  const skew = Math.abs(Date.now() - Number(input.ts));
  if (!Number.isFinite(Number(input.ts)) || skew > 60_000) throw new PlatformError("SIGNATURE", 401);
  const row = await pool.query(
    `SELECT user_id, scopes, ip_whitelist, secret_sandbox, revoked FROM api_keys WHERE id = $1`,
    [input.keyId],
  );
  if (!row.rowCount || row.rows[0].revoked || !row.rows[0].secret_sandbox) throw new PlatformError("SIGNATURE", 401);
  const secret = row.rows[0].secret_sandbox as string;
  const expect = signV1(secret, input.ts, input.method, input.path, input.body);
  const a = Buffer.from(expect);
  const b = Buffer.from(input.signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new PlatformError("SIGNATURE", 401);
  const allowIp = ((row.rows[0].ip_whitelist as string | null) ?? "").trim();
  if (allowIp) {
    const list = allowIp.split(",").map((item) => item.trim()).filter(Boolean);
    if (!input.ip || !list.includes(input.ip)) throw new PlatformError("IP_DENIED", 403);
  }
  const scopes = String(row.rows[0].scopes || "read").split(",").map((item) => item.trim()).filter(Boolean);
  return { userId: Number(row.rows[0].user_id), scopes };
}

export function scopeOk(scopes: string[], need: "read" | "trade" | "withdraw"): boolean {
  if (need === "withdraw") return false;
  if (need === "read") return scopes.includes("read") || scopes.includes("trade");
  return scopes.includes("trade");
}

const RULES = [
  { id: "wash", title_zh: "对倒 / 自成交", title_en: "Wash / self-match", threshold: 1, window_sec: 300 },
  { id: "spoof", title_zh: "幌骗 / 频繁撤单", title_en: "Spoofing / layering", threshold: 8, window_sec: 60 },
  { id: "manipulation", title_zh: "偏离参考价", title_en: "Price vs reference", threshold: 150, window_sec: 60 },
  { id: "volume", title_zh: "异常成交量", title_en: "Abnormal volume", threshold: 12, window_sec: 300 },
  { id: "large_order", title_zh: "大额委托", title_en: "Large order", threshold: 50000, window_sec: 60 },
  { id: "large_withdraw", title_zh: "大额出金", title_en: "Large withdrawal", threshold: 20000, window_sec: 3600 },
  { id: "velocity", title_zh: "下单速度", title_en: "Order velocity", threshold: 30, window_sec: 60 },
] as const;

export async function ingestSafe(
  pool: Db,
  ev: { userId: number; kind: string; symbol?: string; notionalUusd?: bigint; refBps?: number },
) {
  try {
    await ingest(pool, ev);
  } catch (err) {
    console.error("surv", err);
  }
}

export async function ingest(
  pool: Db,
  ev: { userId: number; kind: string; symbol?: string; notionalUusd?: bigint; refBps?: number },
) {
  await pool.query(
    `INSERT INTO surv_events (user_id, kind, symbol, notional_uusd, ref_bps) VALUES ($1,$2,$3,$4,$5)`,
    [ev.userId, ev.kind, ev.symbol ?? null, ev.notionalUusd?.toString() ?? null, ev.refBps ?? null],
  );
  const rules = await pool.query(`SELECT id, threshold, window_sec, enabled FROM surv_rules`);
  const byId = new Map(rules.rows.map((row) => [row.id as string, row]));
  const hit = async (ruleId: string, detail: string, severity: string) => {
    const rule = byId.get(ruleId);
    if (!rule || rule.enabled === false) return;
    const recent = await pool.query(
      `SELECT 1 FROM surv_alerts WHERE rule_id = $1 AND user_id = $2 AND demo = false AND created_at > now() - interval '2 minutes'`,
      [ruleId, ev.userId],
    );
    if (recent.rowCount) return;
    await pool.query(
      `INSERT INTO surv_alerts (id, rule_id, user_id, symbol, severity, demo, detail)
       VALUES ($1,$2,$3,$4,$5,false,$6)`,
      [crypto.randomUUID(), ruleId, ev.userId, ev.symbol ?? null, severity, detail],
    );
  };
  const countKind = async (kind: string, windowSec: number) => {
    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM surv_events
       WHERE user_id = $1 AND kind = $2 AND created_at > now() - ($3 || ' seconds')::interval`,
      [ev.userId, kind, String(windowSec)],
    );
    return Number(rows.rows[0].n);
  };
  if (ev.kind === "self_trade") {
    const rule = byId.get("wash");
    if (rule && Number(rule.threshold) <= 1) await hit("wash", "尝试与自己的委托成交", "high");
  }
  if (ev.kind === "cancel") {
    const rule = byId.get("spoof");
    const n = await countKind("cancel", Number(rule?.window_sec ?? 60));
    if (rule && n >= Number(rule.threshold)) await hit("spoof", `${n} 笔撤单落在 ${rule.window_sec}s 窗口`, "high");
  }
  if (ev.kind === "place") {
    const rule = byId.get("velocity");
    const n = await countKind("place", Number(rule?.window_sec ?? 60));
    if (rule && n >= Number(rule.threshold)) await hit("velocity", `${n} 笔下单 / ${rule.window_sec}s`, "medium");
  }
  if (ev.kind === "price" && ev.refBps != null) {
    const rule = byId.get("manipulation");
    if (rule && ev.refBps >= Number(rule.threshold)) await hit("manipulation", `偏离参考价 ${ev.refBps} bps`, "high");
  }
  if (ev.kind === "trade") {
    const rule = byId.get("volume");
    const n = await countKind("trade", Number(rule?.window_sec ?? 300));
    if (rule && n >= Number(rule.threshold)) await hit("volume", `${n} 笔成交 / ${rule.window_sec}s`, "medium");
  }
  if (ev.kind === "place" && ev.notionalUusd != null) {
    const rule = byId.get("large_order");
    const usd = Number(ev.notionalUusd / 1_000_000n);
    if (rule && usd >= Number(rule.threshold)) await hit("large_order", `名义金额约 US$${usd.toFixed(0)}`, "medium");
  }
  if (ev.kind === "withdraw" && ev.notionalUusd != null) {
    const rule = byId.get("large_withdraw");
    const usd = Number(ev.notionalUusd / 1_000_000n);
    if (rule && usd >= Number(rule.threshold)) await hit("large_withdraw", `出金 US$${usd.toFixed(0)}`, "high");
  }
}

export async function riskDashboard(pool: Db) {
  const rules = await pool.query(`SELECT id, title_zh, title_en, threshold, window_sec, enabled FROM surv_rules ORDER BY id`);
  const alerts = await pool.query(
    `SELECT a.id, a.rule_id, a.user_id, u.email, a.symbol, a.severity, a.demo, a.detail, a.status, a.created_at
     FROM surv_alerts a LEFT JOIN users u ON u.id = a.user_id
     ORDER BY a.created_at DESC LIMIT 80`,
  );
  const byRule = await pool.query(
    `SELECT rule_id, count(*)::int AS n FROM surv_alerts GROUP BY rule_id ORDER BY n DESC`,
  );
  const series = await pool.query(
    `SELECT to_char(date_trunc('hour', created_at), 'HH24:00') AS t, count(*)::int AS n
     FROM surv_alerts WHERE created_at > now() - interval '12 hours'
     GROUP BY 1 ORDER BY 1`,
  );
  const cases = await pool.query(
    `SELECT c.id, c.title, c.status, c.subject_user_id, s.email AS subject_email, c.assignee_id, a.email AS assignee_email, c.created_at
     FROM risk_cases c
     LEFT JOIN users s ON s.id = c.subject_user_id
     LEFT JOIN users a ON a.id = c.assignee_id
     ORDER BY c.updated_at DESC LIMIT 40`,
  );
  const people = await pool.query(
    `SELECT u.id, u.email, u.role, u.jurisdiction, u.frozen, u.kyc_tier, k.status AS kyc_status,
            (SELECT count(*)::int FROM geo_alerts g WHERE g.user_id = u.id) AS geo_n,
            (SELECT count(*)::int FROM surv_alerts s WHERE s.user_id = u.id AND s.status = 'open') AS alert_n
     FROM users u LEFT JOIN kyc_profiles k ON k.user_id = u.id
     WHERE u.role = 'customer' AND u.is_internal_test = false AND u.address_pool_owner = false ORDER BY u.id LIMIT 40`,
  );
  const scores = people.rows.map((row) => {
    let score = 8;
    if (row.kyc_status === "pending") score += 25;
    if (row.kyc_status === "rejected") score += 40;
    if (row.kyc_tier === "basic") score += 5;
    score += Math.min(30, Number(row.geo_n) * 6);
    score += Math.min(40, Number(row.alert_n) * 12);
    if (row.frozen) score += 20;
    return {
      id: Number(row.id),
      email: row.email,
      jurisdiction: row.jurisdiction,
      kycTier: row.kyc_tier,
      kycStatus: row.kyc_status,
      geoMismatch: Number(row.geo_n),
      openAlerts: Number(row.alert_n),
      frozen: row.frozen,
      score: Math.min(100, score),
    };
  });
  return { rules: rules.rows, alerts: alerts.rows, byRule: byRule.rows, series: series.rows, cases: cases.rows, scores };
}

export async function openCase(pool: Db, actorId: number, input: { alertId?: string; subjectUserId?: number; title: string }) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO risk_cases (id, alert_id, subject_user_id, title, status) VALUES ($1,$2,$3,$4,'open')`,
    [id, input.alertId ?? null, input.subjectUserId ?? null, input.title.slice(0, 160)],
  );
  await pool.query(
    `INSERT INTO risk_case_notes (case_id, actor_id, body, kind) VALUES ($1,$2,$3,'open')`,
    [id, actorId, "立案"],
  );
  return caseView(pool, id);
}

export async function caseAct(
  pool: Db,
  actorId: number,
  caseId: string,
  action: "assign" | "note" | "close" | "reopen",
  body: string,
) {
  const found = await pool.query(`SELECT id FROM risk_cases WHERE id = $1`, [caseId]);
  if (!found.rowCount) throw new PlatformError("NOT_FOUND", 404);
  if (action === "assign") {
    await pool.query(`UPDATE risk_cases SET status = 'assigned', assignee_id = $2, updated_at = now() WHERE id = $1`, [caseId, actorId]);
  } else if (action === "close") {
    await pool.query(`UPDATE risk_cases SET status = 'closed', updated_at = now() WHERE id = $1`, [caseId]);
  } else if (action === "reopen") {
    await pool.query(`UPDATE risk_cases SET status = 'open', updated_at = now() WHERE id = $1`, [caseId]);
  }
  await pool.query(
    `INSERT INTO risk_case_notes (case_id, actor_id, body, kind) VALUES ($1,$2,$3,$4)`,
    [caseId, actorId, body.slice(0, 500) || action, action],
  );
  return caseView(pool, caseId);
}

export async function caseView(pool: Db, id: string) {
  const row = await pool.query(
    `SELECT c.*, s.email AS subject_email, a.email AS assignee_email
     FROM risk_cases c
     LEFT JOIN users s ON s.id = c.subject_user_id
     LEFT JOIN users a ON a.id = c.assignee_id
     WHERE c.id = $1`,
    [id],
  );
  if (!row.rowCount) throw new PlatformError("NOT_FOUND", 404);
  const notes = await pool.query(
    `SELECT n.id, n.kind, n.body, n.created_at, u.email AS actor_email
     FROM risk_case_notes n LEFT JOIN users u ON u.id = n.actor_id
     WHERE n.case_id = $1 ORDER BY n.id`,
    [id],
  );
  return { case: row.rows[0], notes: notes.rows };
}

export async function setRule(pool: Db, id: string, threshold: number, enabled: boolean) {
  const row = await pool.query(
    `UPDATE surv_rules SET threshold = $2, enabled = $3, updated_at = now() WHERE id = $1 RETURNING id, threshold, enabled`,
    [id, threshold, enabled],
  );
  if (!row.rowCount) throw new PlatformError("NOT_FOUND", 404);
  return row.rows[0];
}

async function applyChange(pool: Db, kind: string, payload: Record<string, unknown>, actor: { id: number; email: string }) {
  if (kind === "fee_schedule") {
    const tier = String(payload.vipTier || "");
    const maker = Number(payload.makerBps);
    const taker = Number(payload.takerBps);
    if (!tier || !Number.isFinite(maker) || !Number.isFinite(taker)) throw new PlatformError("VALIDATION");
    const { setNamedSpotFee } = await import("./fees.js");
    await setNamedSpotFee(pool, tier, maker, taker);
  } else if (kind === "instrument") {
    const symbol = String(payload.symbol || "");
    const tick = Number(payload.tickSize);
    const lot = Number(payload.lotSize);
    const band = Number(payload.bandBps);
    const status = String(payload.status || "");
    if (!symbol || !["trading", "halted", "pending"].includes(status)) throw new PlatformError("VALIDATION");
    const updated = await pool.query(
      `UPDATE instruments SET tick_size = $2, lot_size = $3, band_bps = $4, status = $5, updated_at = now() WHERE symbol = $1`,
      [symbol, tick, lot, band, status],
    );
    if (!updated.rowCount) throw new PlatformError("NOT_FOUND", 404);
  } else if (kind === "freeze_user") {
    const email = String(payload.email || "").toLowerCase();
    const frozen = Boolean(payload.frozen);
    const reason = String(payload.reason || "").slice(0, 180);
    const updated = await pool.query(
      `UPDATE users SET frozen = $2, freeze_reason = $3 WHERE email = $1 AND role = 'customer'`,
      [email, frozen, frozen ? reason : null],
    );
    if (!updated.rowCount) throw new PlatformError("NOT_FOUND", 404);
  } else if (kind === "announcement") {
    await pool.query(
      `INSERT INTO announcements (id, title, body, banner, active) VALUES ($1,$2,$3,$4,true)`,
      [crypto.randomUUID(), String(payload.title || "").slice(0, 80), String(payload.body || "").slice(0, 400), Boolean(payload.banner)],
    );
  } else if (kind === "campaign") {
    await pool.query(
      `INSERT INTO campaigns (id, name, reward_points, active) VALUES ($1,$2,$3,true)`,
      [crypto.randomUUID(), String(payload.name || "").slice(0, 80), Number(payload.rewardPoints) || 0],
    );
  } else if (kind === "jurisdiction_bulk") {
    try {
      await applyBulk(pool, payload, actor);
    } catch (err) {
      if (err instanceof CoverageError) throw new PlatformError(err.code);
      throw err;
    }
  } else if (kind === "vip_tier") {
    await pool.query(
      `INSERT INTO vip_tiers (id, min_volume_uusd, min_hold_uusd, maker_bps, taker_bps)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET min_volume_uusd = EXCLUDED.min_volume_uusd, min_hold_uusd = EXCLUDED.min_hold_uusd,
         maker_bps = EXCLUDED.maker_bps, taker_bps = EXCLUDED.taker_bps`,
      [String(payload.id), String(payload.minVolumeUusd), String(payload.minHoldUusd), Number(payload.makerBps), Number(payload.takerBps)],
    );
  } else {
    throw new PlatformError("VALIDATION");
  }
}

export async function proposeChange(pool: Db, makerId: number, kind: string, payload: Record<string, unknown>) {
  if (kind === "jurisdiction_bulk") {
    try {
      assertBulk(payload);
    } catch (err) {
      if (err instanceof CoverageError) throw new PlatformError(err.code);
      throw err;
    }
  }
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO change_requests (id, kind, payload, status, maker_id) VALUES ($1,$2,$3::jsonb,'pending',$4)`,
    [id, kind, JSON.stringify(payload), makerId],
  );
  await audit(pool, makerId, "change_propose", JSON.stringify({ id, kind }));
  return { id, status: "pending" };
}

export async function decideChange(pool: Db, checkerId: number, id: string, action: "approve" | "reject", reason: string) {
  const row = await pool.query(`SELECT * FROM change_requests WHERE id = $1`, [id]);
  if (!row.rowCount) throw new PlatformError("NOT_FOUND", 404);
  const req = row.rows[0];
  if (req.status !== "pending") throw new PlatformError("VALIDATION");
  const checker = await pool.query(`SELECT email, role FROM users WHERE id = $1`, [checkerId]);
  const checkerRole = checker.rows[0]?.role as string | undefined;
  if (Number(req.maker_id) === checkerId && checkerRole !== "admin") throw new PlatformError("MAKER_CHECKER", 403);
  const detail = JSON.stringify({
    id,
    kind: req.kind,
    makerId: Number(req.maker_id),
    self: Number(req.maker_id) === checkerId,
    reason: reason.slice(0, 180),
  });
  if (action === "reject") {
    await pool.query(
      `UPDATE change_requests SET status = 'rejected', checker_id = $2, reason = $3, decided_at = now() WHERE id = $1`,
      [id, checkerId, reason.slice(0, 180)],
    );
    await audit(pool, checkerId, "change_reject", detail);
    return { id, status: "rejected" };
  }
  await applyChange(pool, req.kind as string, req.payload as Record<string, unknown>, {
    id: checkerId,
    email: (checker.rows[0]?.email as string | undefined) ?? "checker",
  });
  await pool.query(
    `UPDATE change_requests SET status = 'approved', checker_id = $2, reason = $3, decided_at = now() WHERE id = $1`,
    [id, checkerId, reason.slice(0, 180)],
  );
  await audit(pool, checkerId, "change_approve", detail);
  return { id, status: "approved" };
}

export async function opsOverview(pool: Db) {
  const users = await pool.query(`SELECT count(*)::int AS n FROM users WHERE role = 'customer' AND is_internal_test = false AND address_pool_owner = false`);
  const frozen = await pool.query(`SELECT count(*)::int AS n FROM users WHERE frozen`);
  const pending = await pool.query(`SELECT count(*)::int AS n FROM change_requests WHERE status = 'pending'`);
  const fees = await pool.query(`SELECT vip_tier, maker_bps, taker_bps FROM fee_schedules ORDER BY vip_tier`);
  const vips = await pool.query(`SELECT id, min_volume_uusd::text, min_hold_uusd::text, maker_bps, taker_bps FROM vip_tiers ORDER BY min_volume_uusd`);
  const instruments = await pool.query(
    `SELECT symbol, tick_size::text, lot_size::text, band_bps, status FROM instruments ORDER BY symbol LIMIT 12`,
  );
  const announcements = await pool.query(`SELECT id, title, body, banner, active, created_at FROM announcements ORDER BY created_at DESC LIMIT 8`);
  const campaigns = await pool.query(`SELECT id, name, reward_points, active FROM campaigns ORDER BY created_at DESC`);
  const changes = await pool.query(
    `SELECT c.id, c.kind, c.status, c.payload, c.reason, c.created_at, c.decided_at, m.email AS maker_email, k.email AS checker_email
     FROM change_requests c
     JOIN users m ON m.id = c.maker_id
     LEFT JOIN users k ON k.id = c.checker_id
     ORDER BY c.created_at DESC LIMIT 20`,
  );
  return {
    customers: users.rows[0].n as number,
    frozen: frozen.rows[0].n as number,
    pendingChanges: pending.rows[0].n as number,
    fees: fees.rows,
    vips: vips.rows,
    instruments: instruments.rows,
    announcements: announcements.rows,
    campaigns: campaigns.rows,
    changes: changes.rows,
  };
}

export async function searchUsers(pool: Db, q: string) {
  const like = `%${q.slice(0, 60)}%`;
  const rows = await pool.query(
    `SELECT u.id, u.email, u.role, u.jurisdiction, u.frozen, u.freeze_reason, u.kyc_tier, u.created_at,
            k.status AS kyc_status
     FROM users u LEFT JOIN kyc_profiles k ON k.user_id = u.id
     WHERE u.role = 'customer' AND u.is_internal_test = false AND u.address_pool_owner = false AND ($1 = '%%' OR u.email ILIKE $1)
     ORDER BY u.id LIMIT 40`,
    [like],
  );
  return rows.rows;
}

export async function reports(pool: Db) {
  const dau = await pool.query(
    `SELECT count(DISTINCT e.user_id)::int AS n
     FROM login_events e JOIN users u ON u.id = e.user_id
     WHERE e.created_at > now() - interval '1 day' AND u.is_internal_test = false AND u.address_pool_owner = false`,
  );
  const mau = await pool.query(
    `SELECT count(DISTINCT e.user_id)::int AS n
     FROM login_events e JOIN users u ON u.id = e.user_id
     WHERE e.created_at > now() - interval '30 days' AND u.is_internal_test = false AND u.address_pool_owner = false`,
  );
  const signups = await pool.query(
    `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::int AS n
     FROM users WHERE role = 'customer' AND is_internal_test = false AND address_pool_owner = false AND created_at > now() - interval '14 days'
     GROUP BY 1 ORDER BY 1`,
  );
  const funded = await pool.query(
    `SELECT count(DISTINCT a.customer_id)::int AS n
     FROM accounts a JOIN balances b ON b.account_id = a.id
     JOIN users u ON u.id = a.customer_id
     WHERE a.customer_id IS NOT NULL AND u.is_internal_test = false AND u.address_pool_owner = false
       AND a.asset = 'USD' AND a.bucket = 'available' AND b.amount > 0`,
  );
  const byDay = await pool.query(
    `SELECT to_char(date_trunc('day', tape_at), 'YYYY-MM-DD') AS day,
            COALESCE(SUM(notional_uusd),0)::text AS volume_uusd,
            count(*)::int AS trades
     FROM trades t WHERE t.tape_at > now() - interval '14 days'
       AND NOT EXISTS (
         SELECT 1 FROM users xu WHERE xu.id IN (t.buyer_id, t.seller_id)
           AND (xu.is_internal_test OR xu.address_pool_owner)
       )
     GROUP BY 1 ORDER BY 1`,
  );
  const bySymbol = await pool.query(
    `SELECT symbol, COALESCE(SUM(notional_uusd),0)::text AS volume_uusd, count(*)::int AS trades
     FROM trades t WHERE t.tape_at > now() - interval '30 days'
       AND NOT EXISTS (
         SELECT 1 FROM users xu WHERE xu.id IN (t.buyer_id, t.seller_id)
           AND (xu.is_internal_test OR xu.address_pool_owner)
       )
     GROUP BY symbol ORDER BY SUM(notional_uusd) DESC LIMIT 12`,
  );
  const byJur = await pool.query(
    `SELECT COALESCE(u.jurisdiction, '—') AS jurisdiction, COALESCE(SUM(t.notional_uusd),0)::text AS volume_uusd
     FROM trades t
     LEFT JOIN users u ON u.id = t.buyer_id
     WHERE t.tape_at > now() - interval '30 days'
       AND NOT EXISTS (
         SELECT 1 FROM users xu WHERE xu.id IN (t.buyer_id, t.seller_id)
           AND (xu.is_internal_test OR xu.address_pool_owner)
       )
     GROUP BY 1 ORDER BY SUM(t.notional_uusd) DESC`,
  );
  const convertFees = await pool.query(`SELECT COALESCE(SUM(fee_uusd),0)::text AS n FROM convert_fills`);
  const taker = await pool.query(`SELECT taker_bps FROM fee_schedules WHERE vip_tier = 'standard'`);
  const bps = Number(taker.rows[0]?.taker_bps ?? 10);
  const charged = await pool.query(
    `SELECT COALESCE(SUM(COALESCE(buyer_fee_uusd, 0) + COALESCE(seller_fee_uusd, 0)), 0)::text AS n
     FROM trades WHERE tape_at > now() - interval '30 days'`,
  );
  const liveCharged = await pool.query(
    `SELECT COALESCE(SUM(COALESCE(fee_uusd, 0)), 0)::text AS n
     FROM real_fills WHERE created_at > now() - interval '30 days' AND kind IN ('open', 'close', 'liquidation')`,
  );
  const accrued =
    BigInt((charged.rows[0]?.n as string) ?? "0") +
    BigInt((liveCharged.rows[0]?.n as string) ?? "0") +
    BigInt((convertFees.rows[0]?.n as string) ?? "0");
  return {
    dau: dau.rows[0].n as number,
    mau: mau.rows[0].n as number,
    funded: funded.rows[0].n as number,
    signups: signups.rows,
    byDay: byDay.rows,
    bySymbol: bySymbol.rows,
    byJurisdiction: byJur.rows,
    feeBps: bps,
    feeUusd: accrued.toString(),
    convertFeeUusd: convertFees.rows[0]?.n ?? "0",
  };
}

export function reportsCsv(data: Awaited<ReturnType<typeof reports>>): string {
  const lines = ["day,trades,volume_uusd"];
  for (const row of data.byDay) lines.push(`${row.day},${row.trades},${row.volume_uusd}`);
  lines.push("");
  lines.push("symbol,trades,volume_uusd");
  for (const row of data.bySymbol) lines.push(`${row.symbol},${row.trades},${row.volume_uusd}`);
  lines.push("");
  lines.push(`dau,${data.dau}`);
  lines.push(`mau,${data.mau}`);
  lines.push(`funded,${data.funded}`);
  lines.push(`fee_uusd,${data.feeUusd}`);
  return lines.join("\n");
}

export async function growthView(pool: Db, userId: number) {
  const user = await pool.query(
    `SELECT email, referral_code, points, phishing_code FROM users WHERE id = $1`,
    [userId],
  );
  const volume = await pool.query(
    `SELECT COALESCE(SUM(notional_uusd),0)::text AS n FROM trades
     WHERE tape_at > now() - interval '30 days' AND (buyer_id = $1 OR seller_id = $1)`,
    [userId],
  );
  const hold = await pool.query(
    `SELECT COALESCE(SUM(b.amount),0)::text AS n
     FROM accounts a JOIN balances b ON b.account_id = a.id
     WHERE a.customer_id = $1 AND a.asset = 'USD' AND a.bucket = 'available'`,
    [userId],
  );
  const tiers = await pool.query(`SELECT id, min_volume_uusd::text, min_hold_uusd::text, maker_bps, taker_bps FROM vip_tiers ORDER BY min_volume_uusd`);
  const vol = BigInt((volume.rows[0]?.n as string) ?? "0");
  const held = BigInt((hold.rows[0]?.n as string) ?? "0");
  let tier = tiers.rows[0];
  for (const row of tiers.rows) {
    const minVol = BigInt(row.min_volume_uusd as string);
    const minHold = BigInt(row.min_hold_uusd as string);
    if (vol >= minVol || (minHold > 0n && held >= minHold)) tier = row;
  }
  const tasks = await pool.query(
    `SELECT t.id, t.code, t.title_zh, t.title_en, t.points, t.needs_approval, COALESCE(u.status, 'open') AS status
     FROM reward_tasks t
     LEFT JOIN user_tasks u ON u.task_id = t.id AND u.user_id = $1
     ORDER BY t.points`,
    [userId],
  );
  const invites = await pool.query(
    `SELECT r.id, r.commission_uusd::text, r.created_at, u.email AS invitee
     FROM referrals r JOIN users u ON u.id = r.invitee_id
     WHERE r.inviter_id = $1 ORDER BY r.created_at DESC`,
    [userId],
  );
  return {
    code: user.rows[0]?.referral_code,
    points: Number(user.rows[0]?.points ?? 0),
    volumeUusd: vol.toString(),
    holdUusd: held.toString(),
    tier,
    tiers: tiers.rows,
    tasks: tasks.rows,
    invites: invites.rows,
    regulatory: "奖励、返佣和积分可能需要额外的牌照或豁免。此沙盒只做模拟记账，不进入复式账本。",
  };
}

export async function claimReferral(pool: Db, userId: number, code: string) {
  const inviter = await pool.query(`SELECT id FROM users WHERE referral_code = $1`, [code.trim()]);
  if (!inviter.rowCount) throw new PlatformError("NOT_FOUND", 404);
  const inviterId = Number(inviter.rows[0].id);
  if (inviterId === userId) throw new PlatformError("VALIDATION");
  const existing = await pool.query(`SELECT referred_by FROM users WHERE id = $1`, [userId]);
  if (existing.rows[0]?.referred_by) throw new PlatformError("VALIDATION");
  await pool.query(`UPDATE users SET referred_by = $2 WHERE id = $1`, [userId, inviterId]);
  const volume = await pool.query(
    `SELECT COALESCE(SUM(notional_uusd),0)::text AS n FROM trades WHERE buyer_id = $1 OR seller_id = $1`,
    [userId],
  );
  const commission = BigInt((volume.rows[0]?.n as string) ?? "0") / 1000n;
  await pool.query(
    `INSERT INTO referrals (id, code, inviter_id, invitee_id, commission_uusd) VALUES ($1,$2,$3,$4,$5)`,
    [crypto.randomUUID(), code.trim(), inviterId, userId, commission.toString()],
  );
  await pool.query(`UPDATE users SET points = points + 100 WHERE id = $1`, [inviterId]);
  return { ok: true, commissionUusd: commission.toString() };
}

export async function accrueCommission(pool: Db, userId: number, notionalUusd: bigint) {
  if (notionalUusd <= 0n) return;
  const cut = notionalUusd / 1000n;
  if (cut <= 0n) return;
  await pool.query(
    `UPDATE referrals SET commission_uusd = commission_uusd + $2 WHERE invitee_id = $1`,
    [userId, cut.toString()],
  );
}

export async function completeTask(pool: Db, userId: number, code: string) {
  const task = await pool.query(`SELECT id, points, needs_approval FROM reward_tasks WHERE code = $1`, [code]);
  if (!task.rowCount) throw new PlatformError("NOT_FOUND", 404);
  const status = task.rows[0].needs_approval ? "pending_approval" : "done";
  await pool.query(
    `INSERT INTO user_tasks (user_id, task_id, status) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, task_id) DO NOTHING`,
    [userId, task.rows[0].id, status],
  );
  if (!task.rows[0].needs_approval) {
    await pool.query(`UPDATE users SET points = points + $2 WHERE id = $1`, [userId, task.rows[0].points]);
  }
  return { status, needsApproval: task.rows[0].needs_approval };
}

export async function helpSearch(pool: Db, q: string) {
  const like = `%${q.slice(0, 40)}%`;
  const rows = await pool.query(
    `SELECT id, title_zh, title_en, title_ms, body_zh, body_en, body_ms, tags FROM help_articles
     WHERE $1 = '%%' OR title_zh ILIKE $1 OR title_en ILIKE $1 OR title_ms ILIKE $1
        OR body_zh ILIKE $1 OR body_en ILIKE $1 OR body_ms ILIKE $1 OR tags ILIKE $1
     ORDER BY id LIMIT 20`,
    [like],
  );
  return rows.rows;
}

export async function postChat(
  pool: Db,
  userId: number,
  authorId: number,
  body: string,
  staff: boolean,
  topic: string | null = null,
) {
  if (staff) {
    const screen = await screenStaffMessage(pool, userId, body);
    if (!screen.ok) {
      await recordPaymentBlock(pool, authorId, userId, screen.kind, body);
      throw new PlatformError("PAYMENT_REDACTED", 422);
    }
  }
  const safeTopic = topic === "deposit" ? "deposit" : null;
  await pool.query(
    `INSERT INTO chat_messages (user_id, author_id, body, staff, topic, kind) VALUES ($1,$2,$3,$4,$5,'text')`,
    [userId, authorId, body.slice(0, 500), staff, safeTopic],
  );
  return recentChat(pool, userId);
}

export async function chatInbox(pool: Db) {
  const rows = await pool.query(
    `SELECT c.user_id, u.email, max(c.id) AS last_id, count(*)::int AS n
     FROM chat_messages c JOIN users u ON u.id = c.user_id
     GROUP BY c.user_id, u.email ORDER BY max(c.id) DESC LIMIT 30`,
  );
  return rows.rows;
}

export async function openTicket(pool: Db, userId: number, subject: string, body: string) {
  const id = crypto.randomUUID();
  await pool.query(`INSERT INTO tickets (id, user_id, subject, status) VALUES ($1,$2,$3,'open')`, [
    id,
    userId,
    subject.slice(0, 120),
  ]);
  await pool.query(
    `INSERT INTO ticket_messages (ticket_id, author_id, body, staff) VALUES ($1,$2,$3,false)`,
    [id, userId, body.slice(0, 1000)],
  );
  return { id };
}

export async function listTickets(pool: Db, userId: number | null) {
  const rows = userId
    ? await pool.query(
        `SELECT t.id, t.subject, t.status, t.created_at, u.email FROM tickets t JOIN users u ON u.id = t.user_id
         WHERE t.user_id = $1 ORDER BY t.created_at DESC LIMIT 30`,
        [userId],
      )
    : await pool.query(
        `SELECT t.id, t.subject, t.status, t.created_at, u.email FROM tickets t JOIN users u ON u.id = t.user_id
         ORDER BY t.created_at DESC LIMIT 40`,
      );
  return rows.rows;
}

export async function replyTicket(pool: Db, ticketId: string, authorId: number, body: string, staff: boolean) {
  const found = await pool.query(`SELECT user_id FROM tickets WHERE id = $1`, [ticketId]);
  if (!found.rowCount) throw new PlatformError("NOT_FOUND", 404);
  if (!staff && Number(found.rows[0].user_id) !== authorId) throw new PlatformError("FORBIDDEN", 403);
  if (staff) {
    const screen = await screenStaffMessage(pool, Number(found.rows[0].user_id), body);
    if (!screen.ok) {
      await recordPaymentBlock(pool, authorId, Number(found.rows[0].user_id), screen.kind, body);
      throw new PlatformError("PAYMENT_REDACTED", 422);
    }
  }
  await pool.query(
    `INSERT INTO ticket_messages (ticket_id, author_id, body, staff) VALUES ($1,$2,$3,$4)`,
    [ticketId, authorId, body.slice(0, 1000), staff],
  );
  if (staff) await pool.query(`UPDATE tickets SET status = 'pending', updated_at = now() WHERE id = $1`, [ticketId]);
  const notes = await pool.query(
    `SELECT id, body, staff, created_at FROM ticket_messages WHERE ticket_id = $1 ORDER BY id`,
    [ticketId],
  );
  return notes.rows;
}

const STAFF = [
  { email: "founder@meridexexchange.com", password: "<redacted>", secret: "<redacted>", role: "admin" },
  { email: "risk@meridexexchange.com", password: "<redacted>", secret: "<redacted>", role: "risk" },
  { email: "ops@meridexexchange.com", password: "<redacted>", secret: "<redacted>", role: "ops" },
  { email: "ops.checker@meridexexchange.com", password: "<redacted>", secret: "<redacted>", role: "ops" },
  { email: "support@meridexexchange.com", password: "<redacted>", secret: "<redacted>", role: "support" },
] as const;

export async function seedPlatform(pool: Db) {
  for (const person of STAFF) {
    const existing = await pool.query(`SELECT id FROM users WHERE email = $1`, [person.email]);
    if (existing.rowCount) {
      await pool.query(
        `UPDATE users SET totp_secret = $2, password_hash = $3 WHERE email = $1`,
        [person.email, person.secret, hashPassword(person.password)],
      );
      continue;
    }
    await pool.query(
      `INSERT INTO users (email, password_hash, totp_secret, role, entity_id, jurisdiction, kyc_tier)
       VALUES ($1,$2,$3,$4,'SG-OPCO','SG','staff')`,
      [person.email, hashPassword(person.password), person.secret, person.role],
    );
    const id = await pool.query(`SELECT id FROM users WHERE email = $1`, [person.email]);
    await pool.query(
      `INSERT INTO kyc_profiles (user_id, nationality, residence_country, sanctions_hit, status, reason, entity_id)
       VALUES ($1,'SG','SG',false,'approved','STAFF','SG-OPCO')
       ON CONFLICT (user_id) DO NOTHING`,
      [id.rows[0].id],
    );
  }
  await pool.query(`UPDATE users SET address_pool_owner = (email = 'founder@meridexexchange.com')`);
  await pool.query(
    `DELETE FROM totp_lockouts WHERE user_id = (SELECT id FROM users WHERE email = 'founder@meridexexchange.com')`,
  );
  const owner = await pool.query(`SELECT id FROM users WHERE email = 'founder@meridexexchange.com'`);
  if (owner.rowCount) await seedAddressPool(pool, Number(owner.rows[0].id));
  await pool.query(
    `UPDATE users SET referral_code = 'MERIDEX-SG'
     WHERE email = 'client@meridexexchange.com' AND referral_code IS NULL`,
  );
  const supportStaff = STAFF.find((person) => person.role === "support");
  if (supportStaff) {
    await pool.query(
      `UPDATE users AS customer
       SET account_manager_id = manager.id, vip_desk = true
       FROM users AS manager
       WHERE customer.email = 'client@meridexexchange.com'
         AND manager.email = $1
         AND customer.account_manager_id IS NULL`,
      [supportStaff.email],
    );
  }
  for (const rule of RULES) {
    await pool.query(
      `INSERT INTO surv_rules (id, title_zh, title_en, threshold, window_sec) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO NOTHING`,
      [rule.id, rule.title_zh, rule.title_en, rule.threshold, rule.window_sec],
    );
  }
  const fees = [
    ["standard", 10, 10],
    ["silver", 9, 10],
    ["gold", 8, 10],
    ["private", 4, 6],
  ] as const;
  for (const [tier, maker, taker] of fees) {
    await pool.query(
      `INSERT INTO fee_schedules (vip_tier, maker_bps, taker_bps) VALUES ($1,$2,$3) ON CONFLICT (vip_tier) DO NOTHING`,
      [tier, maker, taker],
    );
  }
  const tiers = [
    ["standard", "0", "0", 10, 10],
    ["silver", "1000000000000", "0", 9, 10],
    ["gold", "5000000000000", "0", 8, 10],
    ["private", "20000000000000", "0", 4, 6],
  ] as const;
  for (const [id, vol, hold, maker, taker] of tiers) {
    await pool.query(
      `INSERT INTO vip_tiers (id, min_volume_uusd, min_hold_uusd, maker_bps, taker_bps) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO NOTHING`,
      [id, vol, hold, maker, taker],
    );
  }
  const tasks = [
    ["task-login", "first_login", "完成第一次登录", "Finish the first login", 20, false],
    ["task-deposit", "first_deposit", "完成一笔模拟入金", "Make a simulated deposit", 80, true],
    ["task-trade", "first_trade", "完成第一笔现货成交", "Complete a first spot fill", 120, true],
  ] as const;
  for (const task of tasks) {
    await pool.query(
      `INSERT INTO reward_tasks (id, code, title_zh, title_en, points, needs_approval) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET title_zh = EXCLUDED.title_zh, title_en = EXCLUDED.title_en`,
      [...task],
    );
  }
  const articles = [
    ["help-deposit", "模拟入金", "Simulated deposits", "Deposit simulasi", "资金页的入金走模拟银行通道，不会连接真实银行。", "Deposits on the funds page use a mock bank rail.", "Deposit di halaman dana guna landasan bank simulasi. Ia tidak bersambung ke bank sebenar.", "资金,入金"],
    ["help-whitelist", "出金地址白名单", "Withdrawal whitelist", "Senarai putih pengeluaran", "新地址锁定 24 小时。锁定期间出金会被拒绝。", "A new address stays locked for 24 hours.", "Alamat baharu dikunci 24 jam. Pengeluaran ditolak sepanjang tempoh itu.", "安全,出金"],
    ["help-paper", "模拟交易", "Paper trading", "Dagangan simulasi", "模拟余额不进复式账本，可以重置。", "Paper balances never enter the ledger.", "Baki simulasi tidak masuk lejar sebenar dan boleh ditetapkan semula.", "模拟"],
    ["help-api", "开放接口", "Open API", "API terbuka", "私钥只显示一次。默认只有 read 或 trade，没有 withdraw。", "The secret is shown once. Withdraw is not a scope.", "Rahsia dipaparkan sekali sahaja. Skop lalai ialah read atau trade, bukan withdraw.", "API"],
  ] as const;
  for (const article of articles) {
    await pool.query(
      `INSERT INTO help_articles (id, title_zh, title_en, title_ms, body_zh, body_en, body_ms, tags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET
         title_zh = EXCLUDED.title_zh, title_en = EXCLUDED.title_en, title_ms = EXCLUDED.title_ms,
         body_ms = EXCLUDED.body_ms`,
      [...article],
    );
  }
  const breached = ["Password123!", "Qwerty12345!"];
  for (const password of breached) {
    const { prefix, suffix } = sha1Parts(password);
    await pool.query(
      `INSERT INTO password_breaches (prefix, suffix) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [prefix, suffix],
    );
  }
  const demoAlerts = await pool.query(`SELECT count(*)::int AS n FROM surv_alerts WHERE demo = true`);
  if (Number(demoAlerts.rows[0].n) === 0) {
    const bot = await pool.query(`SELECT id FROM users WHERE email = 'bot-flow@internal.meridex'`);
    const botId = bot.rows[0]?.id ?? null;
    const samples = [
      ["wash", "high", "机器人：同一账户在 XAU/USD 上尝试自成交，已被引擎拒绝。这不是客户行为。"],
      ["spoof", "high", "机器人：12 秒内挂出并撤销 14 档买单，用于巡检台。"],
      ["manipulation", "medium", "机器人：一笔成交偏离参考价 180 bps，行情源仍标明指示性。"],
      ["volume", "medium", "机器人：五分钟成交笔数达到平时的 12 倍。"],
      ["large_order", "medium", "机器人：一笔约 US$80,000 的委托触发大额提醒。"],
      ["large_withdraw", "high", "机器人：模拟出金 US$25,000，仅用于告警。"],
      ["velocity", "low", "机器人：一分钟内 40 次下单。"],
    ];
    for (const [rule, severity, detail] of samples) {
      const id = crypto.randomUUID();
      await pool.query(
        `INSERT INTO surv_alerts (id, rule_id, user_id, symbol, severity, demo, detail, created_at)
         VALUES ($1,$2,$3,'XAU/USD',$4,true,$5, now() - (random() * interval '8 hours'))`,
        [id, rule, botId, severity, detail],
      );
    }
    const first = await pool.query(`SELECT id, user_id FROM surv_alerts WHERE demo = true AND rule_id = 'wash' LIMIT 1`);
    const risk = await pool.query(`SELECT id FROM users WHERE email = 'risk@meridexexchange.com'`);
    if (first.rowCount) {
      const caseId = "case-wash";
      await pool.query(
        `INSERT INTO risk_cases (id, alert_id, subject_user_id, title, status, assignee_id)
         VALUES ($1,$2,$3,$4,'assigned',$5)
         ON CONFLICT (id) DO NOTHING`,
        [caseId, first.rows[0].id, first.rows[0].user_id, "案件 · 自成交尝试", risk.rows[0]?.id ?? null],
      );
      await pool.query(
        `INSERT INTO risk_case_notes (case_id, actor_id, body, kind)
         SELECT $1, $2, '由机器人告警自动立案', 'open'
         WHERE NOT EXISTS (SELECT 1 FROM risk_case_notes WHERE case_id = $1)`,
        [caseId, risk.rows[0]?.id ?? null],
      );
    }
  }
  const banner = await pool.query(`SELECT 1 FROM announcements WHERE id = 'ann-notice' OR id = 'ann-demo'`);
  if (!banner.rowCount) {
    await pool.query(
      `INSERT INTO announcements (id, title, body, banner, active) VALUES
       ('ann-notice', '公告', '新加坡牌照申请进行中。奖励与杠杆模式可能需要牌照，页面会标明。', true, true)`,
    );
  }
  const camp = await pool.query(`SELECT 1 FROM campaigns WHERE id = 'camp-welcome' OR id = 'camp-demo'`);
  if (!camp.rowCount) {
    await pool.query(`INSERT INTO campaigns (id, name, reward_points, active) VALUES ('camp-welcome', '新户任务', 200, true)`);
  }
  const demo = await pool.query(`SELECT id FROM users WHERE email = 'client@meridexexchange.com'`);
  const support = await pool.query(`SELECT id FROM users WHERE email = 'support@meridexexchange.com'`);
  if (demo.rowCount && support.rowCount) {
    const chat = await pool.query(`SELECT 1 FROM chat_messages WHERE user_id = $1`, [demo.rows[0].id]);
    if (!chat.rowCount) {
      await pool.query(
        `INSERT INTO chat_messages (user_id, author_id, body, staff) VALUES
         ($1,$1,'出金地址为什么还不能用？', false),
         ($1,$2,'坐席：新地址有 24 小时锁。这不是人工客服。', true)`,
        [demo.rows[0].id, support.rows[0].id],
      );
    }
  }
}

export async function pulseDemoAlert(pool: Db) {
  const n = await pool.query(`SELECT count(*)::int AS c FROM surv_alerts WHERE demo = true`);
  if (Number(n.rows[0].c) > 40) return;
  const bot = await pool.query(`SELECT id FROM users WHERE email = 'bot-flow@internal.meridex'`);
  const rules = ["spoof", "velocity", "volume", "wash"];
  const rule = rules[Math.floor(Date.now() / 60000) % rules.length];
  await pool.query(
    `INSERT INTO surv_alerts (id, rule_id, user_id, symbol, severity, demo, detail)
     VALUES ($1,$2,$3,'XAU/USD','low',true,$4)`,
    [
      crypto.randomUUID(),
      rule,
      bot.rows[0]?.id ?? null,
      "机器人周期告警，不是客户行为。",
    ],
  );
}

export const OPENAPI = {
  openapi: "3.0.3",
  info: {
    title: "MERIDEX sandbox API",
    version: "1.0.0",
    description: "Multi-asset sandbox: precious metals, crypto, commodities, and FX. Public market data needs no key. Private routes use HMAC. Withdraw is not a scope.",
  },
  paths: {
    "/api/v1/market/book": { get: { summary: "Order book", security: [] } },
    "/api/v1/market/trades": { get: { summary: "Recent trades", security: [] } },
    "/api/v1/balances": { get: { summary: "Balances", security: [{ hmac: [] }] } },
    "/api/v1/orders": {
      get: { summary: "Open orders", security: [{ hmac: [] }] },
      post: { summary: "Place order (trade scope)", security: [{ hmac: [] }] },
    },
  },
} as const;
