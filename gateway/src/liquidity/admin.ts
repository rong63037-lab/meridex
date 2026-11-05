import type { Db } from "../db.js";
import { PlatformError } from "../errors.js";
import { assertPoolOwner, requireFreshTotp } from "../pool.js";
import { binanceKeyPresent } from "./binanceDemo.js";
import { binanceDemoBase, coinbaseSandboxBase, saxoSimBase } from "./hosts.js";
import { markHealth } from "./mark.js";
import { lastProbe, saveProbe } from "./probe.js";
import { keyPresence } from "./secrets.js";
import { loadProvider, loadProviders, providerFor, rowFrom } from "./registry.js";
import { exposureView } from "./route.js";
import { saxoKeyPresent } from "./saxoSim.js";
import type { LpMode, ProviderRow } from "./types.js";

function cardKey(row: ProviderRow): "unset" | "present" | "missing" {
  if (row.name === "binance-demo") return binanceKeyPresent() ? "present" : "missing";
  if (row.name === "saxo-sim") return saxoKeyPresent() ? "present" : "missing";
  if (row.name === "coinbase-sandbox") return "missing";
  return keyPresence(row.secretRef);
}

function assertTestHost(name: string, baseUrl: string) {
  if (name === "binance-demo" && !binanceDemoBase(baseUrl).ok) throw new PlatformError("HOST_REFUSED", 400);
  if (name === "saxo-sim" && !saxoSimBase(baseUrl).ok) throw new PlatformError("HOST_REFUSED", 400);
  if (name === "coinbase-sandbox" && !coinbaseSandboxBase(baseUrl).ok) throw new PlatformError("HOST_REFUSED", 400);
}

function num(value: string, min: bigint, max: bigint): bigint {
  if (!/^\d+$/.test(value)) throw new PlatformError("VALIDATION", 400);
  const n = BigInt(value);
  if (n < min || n > max) throw new PlatformError("VALIDATION", 400);
  return n;
}

export async function liquidityOverview(pool: Db) {
  const providers = await loadProviders(pool);
  const kill = await pool.query(`SELECT stopped, updated_at FROM lp_kill WHERE id = 1`);
  const today = await pool.query(
    `SELECT provider_id,
            COALESCE(SUM(notional_uusd) FILTER (WHERE sent), 0)::text AS notional,
            COUNT(*) FILTER (WHERE sent)::int AS sent_n,
            COUNT(*) FILTER (WHERE sent AND status IN ('rejected','timeout','disconnected','expired'))::int AS bad_n,
            COUNT(*) FILTER (WHERE mode = 'shadow' AND intended_px > 0 AND internal_px > 0)::int AS shadow_n,
            COALESCE(AVG(ABS(internal_px - intended_px)::numeric * 10000 / NULLIF(intended_px, 0))
              FILTER (WHERE mode = 'shadow' AND intended_px > 0 AND internal_px > 0), 0)::text AS diff_bps
     FROM lp_routes
     WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
     GROUP BY provider_id`,
  );
  const byId = new Map(today.rows.map((row) => [Number(row.provider_id), row]));
  const cards = [];
  for (const row of providers) {
    const beat = await providerFor(row).heartbeat();
    const probe = lastProbe(row.id);
    const stat = byId.get(row.id);
    const sent = Number(stat?.sent_n ?? 0);
    const bad = Number(stat?.bad_n ?? 0);
    const health = probe ? (probe.ok ? "up" : "down") : beat.ok ? "up" : "down";
    const healthDetail = probe ? (probe.ok ? "OK" : probe.error) : beat.detail;
    cards.push({
      id: row.id,
      name: row.name,
      type: row.type,
      baseUrl: row.baseUrl,
      secretRef: row.secretRef,
      key: cardKey(row),
      enabled: row.enabled,
      mode: row.mode,
      priority: row.priority,
      spreadMarkupBps: row.spreadMarkupBps,
      minQty: row.minQty.toString(),
      maxQty: row.maxQty.toString(),
      perOrderNotionalUusd: row.perOrderNotionalUusd.toString(),
      dailyNotionalUusd: row.dailyNotionalUusd.toString(),
      symbolMap: row.symbolMap,
      health,
      healthDetail,
      latencyMs: probe ? probe.latencyMs : null,
      lastError: probe ? (probe.ok ? "" : probe.error) : beat.ok ? "" : beat.detail,
      todayNotionalUusd: String(stat?.notional ?? "0"),
      rejectRate: sent === 0 ? 0 : bad / sent,
      shadowDiffBps: String(stat?.diff_bps ?? "0"),
    });
  }
  const alerts = await pool.query(
    `SELECT id, kind, asset, detail, created_at FROM lp_alerts ORDER BY id DESC LIMIT 20`,
  );
  const sources = await pool.query(`SELECT id, enabled, stale_ms, outlier_bps, max_book_drift_bps, note FROM lp_mark_sources ORDER BY id`);
  return {
    kill: Boolean(kill.rows[0]?.stopped),
    killUpdatedAt: kill.rows[0]?.updated_at ?? null,
    providers: cards,
    exposure: await exposureView(pool),
    marks: markHealth(),
    markSources: sources.rows,
    alerts: alerts.rows,
  };
}

export async function setProvider(
  pool: Db,
  actor: { id: number; email: string },
  id: number,
  input: {
    mode: LpMode;
    enabled: boolean;
    spreadMarkupBps: number;
    minQty: string;
    maxQty: string;
    perOrderNotionalUusd: string;
    dailyNotionalUusd: string;
    priority: number;
    symbolMap: Record<string, string>;
    baseUrl: string;
    totp?: string;
  },
) {
  if (!["off", "shadow", "live"].includes(input.mode)) throw new PlatformError("VALIDATION", 400);
  if (input.spreadMarkupBps < 0 || input.spreadMarkupBps > 500) throw new PlatformError("VALIDATION", 400);
  if (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 1000) throw new PlatformError("VALIDATION", 400);
  await requireFreshTotp(pool, actor.id, input.totp);
  await assertPoolOwner(pool, actor.id);
  const previous = await loadProvider(pool, id);
  if (!previous) throw new PlatformError("NOT_FOUND", 404);
  assertTestHost(previous.name, input.baseUrl);
  if (input.mode === "live" && input.enabled) {
    /* LIVE is an explicit owner act. The audit row below is the record. */
  }
  const minQty = num(input.minQty, 0n, 10n ** 24n);
  const maxQty = num(input.maxQty, 0n, 10n ** 24n);
  const perOrder = num(input.perOrderNotionalUusd, 0n, 10n ** 18n);
  const daily = num(input.dailyNotionalUusd, 0n, 10n ** 18n);
  await pool.query(
    `UPDATE lp_providers SET
       mode = $2, enabled = $3, spread_markup_bps = $4, min_qty = $5, max_qty = $6,
       per_order_notional_uusd = $7, daily_notional_uusd = $8, priority = $9,
       symbol_map = $10::jsonb, base_url = $11, updated_at = now()
     WHERE id = $1`,
    [
      id,
      input.mode,
      input.enabled,
      input.spreadMarkupBps,
      minQty.toString(),
      maxQty.toString(),
      perOrder.toString(),
      daily.toString(),
      input.priority,
      JSON.stringify(input.symbolMap ?? {}),
      input.baseUrl.slice(0, 200),
    ],
  );
  await pool.query(
    `INSERT INTO lp_audit (actor_user_id, actor_email, action, detail)
     VALUES ($1,$2,'provider_mode',$3::jsonb)`,
    [
      actor.id,
      actor.email,
      JSON.stringify({
        id,
        previous: { mode: previous.mode, enabled: previous.enabled },
        next: { mode: input.mode, enabled: input.enabled },
      }),
    ],
  );
  return liquidityOverview(pool);
}

/** Read-only probe. Does not place an order and does not require an authenticator. */
export async function testProvider(pool: Db, id: number) {
  const row = await loadProvider(pool, id);
  if (!row) throw new PlatformError("NOT_FOUND", 404);
  const adapter = providerFor(row) as { probe?: () => Promise<{ ok: boolean; latencyMs: number; error: string }> };
  const probe = adapter.probe
    ? await adapter.probe()
    : { ok: false, latencyMs: 0, error: "NOT_TESTED" };
  saveProbe(id, probe);
  return {
    id: row.id,
    name: row.name,
    key: cardKey(row),
    ok: probe.ok,
    latencyMs: probe.latencyMs,
    error: probe.error,
    health: probe.ok ? "up" : "down",
  };
}

export async function setKill(pool: Db, actor: { id: number; email: string }, stopped: boolean, totp?: string) {
  await requireFreshTotp(pool, actor.id, totp);
  await assertPoolOwner(pool, actor.id);
  await pool.query(`UPDATE lp_kill SET stopped = $1, updated_at = now() WHERE id = 1`, [stopped]);
  await pool.query(
    `INSERT INTO lp_audit (actor_user_id, actor_email, action, detail) VALUES ($1,$2,'kill',$3::jsonb)`,
    [actor.id, actor.email, JSON.stringify({ stopped })],
  );
  return liquidityOverview(pool);
}

export async function setMarkSource(pool: Db, actor: { id: number; email: string }, id: string, enabled: boolean, totp?: string) {
  await requireFreshTotp(pool, actor.id, totp);
  await assertPoolOwner(pool, actor.id);
  const updated = await pool.query(`UPDATE lp_mark_sources SET enabled = $2, updated_at = now() WHERE id = $1`, [id, enabled]);
  if (!updated.rowCount) throw new PlatformError("NOT_FOUND", 404);
  await pool.query(
    `INSERT INTO lp_audit (actor_user_id, actor_email, action, detail) VALUES ($1,$2,'mark_source',$3::jsonb)`,
    [actor.id, actor.email, JSON.stringify({ id, enabled })],
  );
  return liquidityOverview(pool);
}

export async function setExposureCap(pool: Db, actor: { id: number; email: string }, asset: string, maxAbsQty: string, totp?: string) {
  await requireFreshTotp(pool, actor.id, totp);
  await assertPoolOwner(pool, actor.id);
  if (!/^[A-Z0-9]{2,12}$/.test(asset)) throw new PlatformError("VALIDATION", 400);
  const qty = num(maxAbsQty, 0n, 10n ** 24n);
  await pool.query(
    `INSERT INTO lp_exposure_caps (asset, max_abs_qty) VALUES ($1,$2)
     ON CONFLICT (asset) DO UPDATE SET max_abs_qty = EXCLUDED.max_abs_qty`,
    [asset, qty.toString()],
  );
  await pool.query(
    `INSERT INTO lp_audit (actor_user_id, actor_email, action, detail) VALUES ($1,$2,'exposure_cap',$3::jsonb)`,
    [actor.id, actor.email, JSON.stringify({ asset, maxAbsQty: qty.toString() })],
  );
  return liquidityOverview(pool);
}

function cells(line: string): string[] {
  return line.split(",").map((part) => part.trim().replace(/^"|"$/g, ""));
}

/**
 * Compare a provider statement with local fills.
 * This never posts a journal and never changes a customer balance.
 */
export async function importStatement(pool: Db, providerId: number, csv: string) {
  const provider = await loadProvider(pool, providerId);
  if (!provider) throw new PlatformError("NOT_FOUND", 404);
  const lines = csv.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new PlatformError("VALIDATION", 400);
  const header = cells(lines[0]).map((cell) => cell.toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const fillCol = idx("fill_id");
  if (fillCol < 0) throw new PlatformError("VALIDATION", 400);
  let matched = 0;
  let breaks = 0;
  for (const line of lines.slice(1)) {
    const col = cells(line);
    const fillId = col[fillCol] ?? "";
    if (!fillId) continue;
    const clientOrderId = col[idx("client_order_id")] ?? "";
    const symbol = col[idx("symbol")] ?? "";
    const side = col[idx("side")] ?? "";
    const qty = col[idx("qty")] ?? "";
    const px = col[idx("px")] ?? "";
    const local = await pool.query(
      `SELECT qty::text, px::text, client_order_id FROM lp_fills WHERE provider_id = $1 AND fill_id = $2`,
      [providerId, fillId],
    );
    let reason: string | null = null;
    if (!local.rowCount) reason = "missing_local";
    else if (qty && local.rows[0].qty !== qty) reason = "qty";
    else if (px && local.rows[0].px !== px) reason = "px";
    else if (clientOrderId && local.rows[0].client_order_id !== clientOrderId) reason = "client_order_id";
    const ok = reason == null;
    if (ok) matched += 1;
    else breaks += 1;
    await pool.query(
      `INSERT INTO lp_statements (provider_id, external_fill_id, client_order_id, symbol, side, qty, px, matched, break_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (provider_id, external_fill_id) DO UPDATE
         SET matched = EXCLUDED.matched, break_reason = EXCLUDED.break_reason, qty = EXCLUDED.qty, px = EXCLUDED.px`,
      [providerId, fillId, clientOrderId || null, symbol || null, side || null, qty || null, px || null, ok, reason],
    );
  }
  return { matched, breaks };
}

export async function statementBreaks(pool: Db) {
  const rows = await pool.query(
    `SELECT id, provider_id, external_fill_id, client_order_id, symbol, side, qty, px, matched, break_reason, imported_at
     FROM lp_statements ORDER BY id DESC LIMIT 50`,
  );
  return rows.rows;
}

export { rowFrom };
