/** Counts for the admin home, and the last backup the script wrote. */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Db } from "./db.js";
import { feedReport } from "./feedStatus.js";

export type BackupStatus = {
  ok: boolean;
  status: "ok" | "failed" | "none";
  at: string | null;
  file: string | null;
  bytes: number | null;
  error?: string;
};

export function backupDir(): string {
  return process.env.MERIDEX_BACKUP_DIR || join(homedir(), "meridex", "backups");
}

export function backupStatus(): BackupStatus {
  const file = join(backupDir(), "latest.json");
  if (!existsSync(file)) return { ok: false, status: "none", at: null, file: null, bytes: null };
  try {
    const body = JSON.parse(readFileSync(file, "utf8")) as { ok?: boolean; at?: string; file?: string; bytes?: number; error?: string };
    const ok = Boolean(body.ok);
    const name = body.file ? body.file.split("/").pop() ?? body.file : null;
    return {
      ok,
      status: ok ? "ok" : "failed",
      at: body.at ?? null,
      file: name,
      bytes: typeof body.bytes === "number" ? body.bytes : null,
      ...(body.error ? { error: String(body.error).slice(0, 180) } : {}),
    };
  } catch {
    return { ok: false, status: "failed", at: null, file: null, bytes: null, error: "latest.json" };
  }
}

export async function todoCounts(pool: Db) {
  const claims = await pool.query(`SELECT count(*)::int AS n FROM deposit_claims WHERE status = 'pending'`);
  const withdrawals = await pool.query(`SELECT count(*)::int AS n FROM withdrawal_requests WHERE status = 'pending'`);
  const kyc = await pool.query(
    `SELECT count(*)::int AS n
     FROM kyc_profiles k JOIN users u ON u.id = k.user_id
     WHERE k.status = 'pending' AND u.is_internal_test = false`,
  );
  const chats = await pool.query(
    `SELECT count(*)::int AS n FROM (
       SELECT DISTINCT ON (c.user_id) c.staff
       FROM chat_messages c
       JOIN users u ON u.id = c.user_id
       WHERE u.is_internal_test = false
       ORDER BY c.user_id, c.id DESC
     ) t
     WHERE t.staff = false`,
  );
  const feeds = feedReport();
  let feedProblems = 0;
  if (feeds.lastError || !feeds.ok) feedProblems += 1;
  if (feeds.candles.lastError) feedProblems += 1;
  const backup = backupStatus();
  return {
    claims: Number(claims.rows[0].n),
    withdrawals: Number(withdrawals.rows[0].n),
    kyc: Number(kyc.rows[0].n),
    chats: Number(chats.rows[0].n),
    feeds: feedProblems,
    feedOk: feeds.ok && !feeds.lastError && !feeds.candles.lastError,
    backup,
  };
}
