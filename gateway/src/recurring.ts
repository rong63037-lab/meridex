import type { Db } from "./db.js";
import type { EngineClient } from "./engineClient.js";
import { offeredTo } from "./coverage.js";
import { categoryAccess, getInstrument, quoteNotional, type Instrument } from "./instruments.js";
import { settlePaperPerps } from "./demoModes.js";
import { settleDue } from "./liveTrade.js";
import { LedgerError } from "./ledger.js";
import { ModeError, assertMode } from "./modes.js";
import { PaperReject, paperEnabled, placePaperOrder } from "./paper.js";
import { loadCustomer, placeOrder } from "./trading.js";
import { liveServicesEnabled } from "./runtimeFlags.js";

export type Cadence = "daily" | "weekly" | "monthly";

const CADENCE_MS: Record<Cadence, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

export class PlanError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export async function clockMultiplier(pool: Db): Promise<number> {
  const row = await pool.query(`SELECT multiplier FROM demo_clock WHERE id = 1`);
  const n = Number(row.rows[0]?.multiplier ?? 1);
  return Number.isFinite(n) && n >= 1 ? Math.min(3600, Math.floor(n)) : 1;
}

export async function setClock(pool: Db, multiplier: number): Promise<number> {
  const next = Math.max(1, Math.min(3600, Math.floor(multiplier)));
  await pool.query(
    `INSERT INTO demo_clock (id, multiplier) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET multiplier = EXCLUDED.multiplier`,
    [next],
  );
  return next;
}

function nextRun(cadence: Cadence, multiplier: number, from = Date.now()): Date {
  const span = Math.max(15_000, Math.floor(CADENCE_MS[cadence] / multiplier));
  return new Date(from + span);
}

async function gateInstrument(pool: Db, userId: number, symbol: string): Promise<Instrument> {
  let inst: Instrument;
  try {
    inst = getInstrument(symbol);
  } catch {
    throw new PlanError("UNKNOWN_SYMBOL");
  }
  const customer = await loadCustomer(pool, userId);
  if (!customer) throw new PlanError("KYC_REQUIRED");
  if (inst.status !== "trading") throw new PlanError("MARKET_HALTED");
  if (!offeredTo(customer.jurisdiction)) throw new PlanError("JURISDICTION_CLOSED");
  const access = await categoryAccess(pool, inst.category, customer.jurisdiction);
  if (access === "block") throw new PlanError("CATEGORY_BLOCKED");
  if (access !== "allow") throw new PlanError("CATEGORY_PENDING");
  return inst;
}

export async function createPlan(
  pool: Db,
  userId: number,
  input: { symbol: string; amountUusd: bigint; cadence: Cadence; paper: boolean },
) {
  await assertMode(pool, userId, "recurring", input.paper);
  if (input.paper && !(await paperEnabled(pool, userId))) throw new PlanError("PAPER_OFF");
  if (input.amountUusd <= 0n) throw new PlanError("VALIDATION");
  await gateInstrument(pool, userId, input.symbol);
  const mult = await clockMultiplier(pool);
  const when = nextRun(input.cadence, mult);
  const row = await pool.query(
    `INSERT INTO recurring_plans (user_id, symbol, amount_uusd, cadence, status, namespace, next_run_at)
     VALUES ($1,$2,$3,$4,'active',$5,$6)
     RETURNING id::text, symbol, amount_uusd::text, cadence, status, namespace, next_run_at`,
    [userId, input.symbol, input.amountUusd.toString(), input.cadence, input.paper ? "paper" : "real", when.toISOString()],
  );
  return shapePlan(row.rows[0], "0", null);
}

export async function listPlans(pool: Db, userId: number) {
  const plans = await pool.query(
    `SELECT id::text, symbol, amount_uusd::text, cadence, status, namespace, next_run_at, created_at
     FROM recurring_plans WHERE user_id = $1 ORDER BY id DESC LIMIT 40`,
    [userId],
  );
  const out = [];
  for (const plan of plans.rows) {
    const avg = await pool.query(
      `SELECT COALESCE(SUM(qty),0)::text AS qty, COALESCE(SUM(price_px * qty),0)::text AS usd
       FROM recurring_runs WHERE plan_id = $1 AND status = 'filled' AND qty IS NOT NULL`,
      [plan.id],
    );
    out.push(shapePlan(plan, avg.rows[0].qty as string, avg.rows[0].usd as string));
  }
  const runs = await pool.query(
    `SELECT id::text, plan_id::text, symbol, amount_uusd::text, qty::text, price_px::text, status, detail, namespace, created_at
     FROM recurring_runs WHERE user_id = $1 ORDER BY id DESC LIMIT 40`,
    [userId],
  );
  return { plans: out, runs: runs.rows, clock: await clockMultiplier(pool) };
}

function shapePlan(row: Record<string, unknown>, qty: string, usd: string | null) {
  const q = BigInt(qty || "0");
  const spent = BigInt(usd || "0");
  return {
    id: row.id,
    symbol: row.symbol,
    amountUusd: row.amount_uusd,
    cadence: row.cadence,
    status: row.status,
    namespace: row.namespace,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    filledQty: qty,
    averageCost: q > 0n ? (spent / q).toString() : null,
  };
}

export async function setPlanStatus(pool: Db, userId: number, id: string, action: "pause" | "resume" | "cancel") {
  const row = await pool.query(`SELECT status, namespace FROM recurring_plans WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!row.rowCount) throw new PlanError("NOT_FOUND");
  const status = action === "pause" ? "paused" : action === "resume" ? "active" : "canceled";
  if (action === "resume") await assertMode(pool, userId, "recurring", row.rows[0].namespace === "paper");
  await pool.query(`UPDATE recurring_plans SET status = $2 WHERE id = $1`, [id, status]);
  return { id, status };
}

export async function runPlan(pool: Db, engine: EngineClient, userId: number, id: string, manual: boolean) {
  const row = await pool.query(`SELECT * FROM recurring_plans WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!row.rowCount) throw new PlanError("NOT_FOUND");
  const plan = row.rows[0];
  if (plan.status === "canceled" || (!manual && plan.status !== "active")) throw new PlanError("PLAN_INACTIVE");
  if (manual && plan.status === "paused") {
    /* demo run-now is allowed while paused */
  } else if (plan.status !== "active" && plan.status !== "paused") {
    throw new PlanError("PLAN_INACTIVE");
  }
  if (!manual && plan.status !== "active") throw new PlanError("PLAN_INACTIVE");
  const paper = plan.namespace === "paper";
  if (!paper && !liveServicesEnabled()) throw new PlanError("LIVE_SERVICES_DISABLED");
  await assertMode(pool, userId, "recurring", paper);
  if (paper && !(await paperEnabled(pool, userId))) throw new PlanError("PAPER_OFF");
  const inst = await gateInstrument(pool, userId, plan.symbol as string);
  const amount = BigInt(plan.amount_uusd);
  const book = await engine.book(inst.symbol);
  const ask = book.asks?.[0];
  if (!ask || book.halted) {
    await recordRun(pool, plan, null, null, "failed", book.halted ? "MARKET_HALTED" : "EMPTY_BOOK");
    await bump(pool, plan);
    throw new PlanError(book.halted ? "MARKET_HALTED" : "EMPTY_BOOK");
  }
  const touch = BigInt(Math.round(ask.price));
  const limit = ((touch * 10030n) / 10000n);
  const qty = (amount * BigInt(inst.qtyScale) * BigInt(inst.priceScale)) / (limit * BigInt(inst.quoteScale));
  if (qty < BigInt(inst.minQty)) {
    await recordRun(pool, plan, null, null, "failed", "VALIDATION");
    await bump(pool, plan);
    throw new PlanError("VALIDATION");
  }
  try {
    const placed = paper
      ? await placePaperOrder(pool, engine, userId, { side: "buy", orderType: "ioc", price: limit, qty, symbol: inst.symbol })
      : await placeOrder(pool, engine, (await loadCustomer(pool, userId))!, {
          side: "buy",
          orderType: "ioc",
          priceCents: limit,
          qtyMg: qty,
          symbol: inst.symbol,
        });
    const filled = BigInt(paper ? (placed as { filled: string }).filled : (placed as { filledMg: string }).filledMg);
    if (filled <= 0n) {
      await recordRun(pool, plan, null, null, "failed", "EMPTY_BOOK");
      await bump(pool, plan);
      throw new PlanError("EMPTY_BOOK");
    }
    const px = limit;
    const spent = quoteNotional(filled, px, inst);
    await recordRun(pool, plan, filled, px, "filled", null, spent);
    await bump(pool, plan);
    return { id: String(plan.id), status: "filled", qty: filled.toString(), price: px.toString(), namespace: plan.namespace };
  } catch (err) {
    if (err instanceof PlanError) throw err;
    const code = err instanceof PaperReject || err instanceof LedgerError ? err.code : "REJECTED";
    await recordRun(pool, plan, null, null, "failed", code);
    await bump(pool, plan);
    throw new PlanError(code);
  }
}

async function recordRun(
  pool: Db,
  plan: { id: string | number; user_id: string | number; symbol: string; amount_uusd: string; namespace: string },
  qty: bigint | null,
  px: bigint | null,
  status: string,
  detail: string | null,
  spent?: bigint,
) {
  await pool.query(
    `INSERT INTO recurring_runs (plan_id, user_id, symbol, amount_uusd, qty, price_px, status, detail, namespace)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      plan.id,
      plan.user_id,
      plan.symbol,
      (spent ?? BigInt(plan.amount_uusd)).toString(),
      qty?.toString() ?? null,
      px?.toString() ?? null,
      status,
      detail,
      plan.namespace,
    ],
  );
}

async function bump(pool: Db, plan: { id: string | number; cadence: Cadence; status: string }) {
  if (plan.status === "canceled") return;
  const mult = await clockMultiplier(pool);
  const when = nextRun(plan.cadence, mult);
  await pool.query(`UPDATE recurring_plans SET next_run_at = $2 WHERE id = $1 AND status <> 'canceled'`, [
    plan.id,
    when.toISOString(),
  ]);
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startRecurringLoop(pool: Db, engine: EngineClient) {
  if (timer) return;
  const tick = async () => {
    const due = await pool.query(
      `SELECT id::text, user_id FROM recurring_plans WHERE status = 'active' AND next_run_at <= now() ORDER BY id LIMIT 8`,
    );
    for (const row of due.rows) {
      try {
        await runPlan(pool, engine, Number(row.user_id), row.id as string, false);
      } catch (err) {
        console.error("recurring", row.id, err instanceof Error ? err.message : err);
      }
    }
    await settlePaperPerps(pool, engine);
    await settleDue(pool, engine);
  };
  timer = setInterval(() => {
    void tick().catch((err) => console.error("recurring loop", err));
  }, 15_000);
}

export function asPlanError(err: unknown): PlanError | null {
  if (err instanceof PlanError || err instanceof ModeError) return err instanceof ModeError ? new PlanError(err.code) : err;
  if (err instanceof PaperReject || err instanceof LedgerError) return new PlanError(err.code);
  return null;
}
