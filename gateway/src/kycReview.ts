import type { Db } from "./db.js";
import { withTx } from "./db.js";
import { PlatformError } from "./errors.js";
import { placeOf } from "./coverage.js";
import { decideKyc, type Policy } from "./kyc.js";
import { ensureCustomer } from "./ledger.js";
import { requireFreshTotp } from "./pool.js";

/** Only these staff roles may approve or reject customer KYC. Admin/ops/support are deliberately excluded. */
export const KYC_REVIEW_ROLES = ["risk", "compliance"] as const;

function baseEmail(email: string): string {
  const [local, domain] = email.trim().toLowerCase().split("@");
  return `${(local ?? "").split("+")[0]}@${domain ?? ""}`;
}

async function event(db: { query: Db["query"] }, userId: number, kind: string, detail: unknown) {
  await db.query(`INSERT INTO security_events (user_id, kind, detail) VALUES ($1,$2,$3)`, [
    userId,
    kind,
    JSON.stringify(detail).slice(0, 400),
  ]);
}

export async function logDenied(pool: Db, reviewerId: number, applicantId: string, code: string) {
  await event(pool, reviewerId, "kyc_decision_denied", { applicant: applicantId, code });
}

export async function decideKycReview(
  pool: Db,
  policy: Policy,
  reviewer: { id: number },
  applicantKey: string,
  input: { action: "approve" | "reject"; reason: string; totp?: string },
) {
  const applicantId = Number(applicantKey);
  if (!Number.isInteger(applicantId) || applicantId <= 0) throw new PlatformError("VALIDATION");
  // Role comes from the database, not the token, so a demoted reviewer is refused immediately.
  const staff = await pool.query(`SELECT id, email, role, disabled FROM users WHERE id = $1`, [reviewer.id]);
  const me = staff.rows[0];
  if (!me || me.disabled || !(KYC_REVIEW_ROLES as readonly string[]).includes(String(me.role))) {
    throw new PlatformError("FORBIDDEN", 403);
  }
  if (applicantId === reviewer.id) throw new PlatformError("SELF_REVIEW", 403);
  const who = await pool.query(
    `SELECT id, email, role, address_pool_owner, is_internal_test FROM users WHERE id = $1`,
    [applicantId],
  );
  const applicant = who.rows[0];
  if (!applicant) throw new PlatformError("NOT_FOUND", 404);
  if (applicant.role !== "customer" || applicant.address_pool_owner) throw new PlatformError("SELF_REVIEW", 403);
  if (baseEmail(String(applicant.email)) === baseEmail(String(me.email))) throw new PlatformError("SELF_REVIEW", 403);
  if (applicant.is_internal_test) throw new PlatformError("VALIDATION");
  const reason = input.reason.trim().slice(0, 300);
  if (input.action === "reject" && reason.length < 3) throw new PlatformError("REASON_REQUIRED");
  await requireFreshTotp(pool, reviewer.id, input.totp);

  return withTx(pool, async (client) => {
    const row = await client.query(
      `SELECT nationality, residence_country, sanctions_hit, status FROM kyc_profiles WHERE user_id = $1 FOR UPDATE`,
      [applicantId],
    );
    const profile = row.rows[0];
    if (!profile) throw new PlatformError("NOT_FOUND", 404);
    if (profile.status !== "pending") throw new PlatformError("NOT_PENDING", 409);
    if (input.action === "reject") {
      await client.query(
        `UPDATE kyc_profiles SET status = 'rejected', reason = 'MANUAL_REJECT', entity_id = NULL,
           reviewed_by = $2, reviewed_at = now(), review_note = $3, updated_at = now()
         WHERE user_id = $1`,
        [applicantId, reviewer.id, reason],
      );
      await event(client, reviewer.id, "kyc_reject", { applicant: applicantId, reason });
      await event(client, applicantId, "kyc_rejected", { by: reviewer.id });
      return { userId: applicantId, status: "rejected" as const, reason: "MANUAL_REJECT" };
    }
    // Approve: the same jurisdiction rules submit used to apply, evaluated now.
    const residence = String(profile.residence_country).toUpperCase();
    const decision = decideKyc(
      { nationality: String(profile.nationality), residenceCountry: residence, sanctionsHit: Boolean(profile.sanctions_hit) },
      policy,
    );
    if (decision.status !== "approved" || !decision.entityId) {
      throw new PlatformError(decision.status === "pending" ? "JURISDICTION_NOT_OPEN" : decision.reason, 409);
    }
    if (placeOf(residence)?.risk === "edd") decision.reason = `${residence}_EDD`;
    await client.query(
      `UPDATE kyc_profiles SET status = 'approved', reason = $2, entity_id = $3,
         reviewed_by = $4, reviewed_at = now(), review_note = $5, updated_at = now()
       WHERE user_id = $1`,
      [applicantId, decision.reason, decision.entityId, reviewer.id, reason || null],
    );
    await client.query(`UPDATE users SET entity_id = $2, jurisdiction = $3 WHERE id = $1`, [
      applicantId,
      decision.entityId,
      residence,
    ]);
    // Idempotent: ensureAccount upserts ON CONFLICT (entity_id, code).
    await ensureCustomer(client, { id: applicantId, entityId: decision.entityId, jurisdiction: residence });
    await event(client, reviewer.id, "kyc_approve", { applicant: applicantId, entity: decision.entityId, note: reason });
    await event(client, applicantId, "kyc_approved", { by: reviewer.id });
    return { userId: applicantId, status: "approved" as const, reason: decision.reason, entityId: decision.entityId };
  });
}
