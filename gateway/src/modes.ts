import { isLocked, knownPlace } from "./coverage.js";
import type { Db } from "./db.js";

export const MODES = ["convert", "recurring", "paper", "margin", "perp", "copy"] as const;
export type Mode = (typeof MODES)[number];
export type ModeAccess = "allow" | "pending" | "block";

/** These products stay off the real ledger unless the owner turns the live switch on. */
export const LICENSED = new Set<Mode>(["margin", "perp", "copy"]);

/** CFTC retail: margin and perpetuals stay off for US residents, including paper. */
export const US_HARD = new Set<Mode>(["margin", "perp"]);

export class ModeError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export async function residenceOf(pool: Db, userId: number): Promise<string> {
  const row = await pool.query(`SELECT residence_country FROM kyc_profiles WHERE user_id = $1`, [userId]);
  const country = row.rows[0]?.residence_country as string | undefined;
  if (!country) throw new ModeError("KYC_REQUIRED");
  return country;
}

export async function modeAccess(pool: Db, mode: Mode, country: string): Promise<ModeAccess> {
  const row = await pool.query(`SELECT access FROM mode_access WHERE mode = $1 AND country = $2`, [mode, country]);
  return (row.rows[0]?.access as ModeAccess | undefined) ?? "block";
}

/**
 * Real accounts cannot use licensed modes.
 * US residents cannot use margin or perpetuals even when the switch says allow, and even in paper.
 * Other modes follow mode_access for the residence.
 */
export async function assertMode(pool: Db, userId: number, mode: Mode, paper: boolean): Promise<string> {
  const country = await residenceOf(pool, userId);
  if (US_HARD.has(mode) && country === "US") throw new ModeError("US_RETAIL_BLOCK");
  if (LICENSED.has(mode) && !paper) throw new ModeError("DEMO_ONLY");
  const access = await modeAccess(pool, mode, country);
  if (access === "allow") return country;
  throw new ModeError(access === "pending" ? "MODE_PENDING" : "MODE_BLOCKED");
}

export async function setModeAccess(
  pool: Db,
  actor: { id: number; email: string },
  mode: Mode,
  country: string,
  access: ModeAccess,
): Promise<void> {
  if (!knownPlace(country)) throw new ModeError("VALIDATION");
  if (isLocked(country)) throw new ModeError("JURISDICTION_LOCKED");
  if (!MODES.includes(mode)) throw new ModeError("VALIDATION");
  if (US_HARD.has(mode) && country === "US" && access === "allow") throw new ModeError("US_RETAIL_BLOCK");
  const current = await pool.query(`SELECT access FROM mode_access WHERE mode = $1 AND country = $2`, [mode, country]);
  const previous = (current.rows[0]?.access as string | undefined) ?? null;
  await pool.query(
    `INSERT INTO mode_access (mode, country, access, updated_at)
     VALUES ($1,$2,$3,now())
     ON CONFLICT (mode, country) DO UPDATE SET access = EXCLUDED.access, updated_at = now()`,
    [mode, country, access],
  );
  await pool.query(
    `INSERT INTO mode_audit (mode, country, previous_access, access, actor_user_id, actor_email)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [mode, country, previous, access, actor.id, actor.email],
  );
}

export async function modeView(pool: Db) {
  const rules = await pool.query(
    `SELECT mode, country, access, updated_at FROM mode_access ORDER BY mode, country`,
  );
  const audit = await pool.query(
    `SELECT id, mode, country, previous_access, access, actor_email, created_at
     FROM mode_audit ORDER BY id DESC LIMIT 40`,
  );
  return {
    rules: rules.rows,
    audit: audit.rows,
    licensed: [...LICENSED],
    usHard: [...US_HARD],
  };
}
