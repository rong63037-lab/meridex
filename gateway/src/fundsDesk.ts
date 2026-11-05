/** The simple funds queue: deposit claims waiting to be credited. */
import type { Db } from "./db.js";

export async function listDepositQueue(pool: Db, status: string, q: string) {
  const filter = status === "pending" || status === "credited" || status === "dismissed" ? status : "";
  const query = q.trim().slice(0, 120);
  const rows = await pool.query(
    `SELECT c.id, c.user_id, u.email, u.fund_id, u.display_name, u.is_internal_test,
            c.asset, c.network, c.amount, c.reference, c.status, c.created_at
     FROM deposit_claims c
     JOIN users u ON u.id = c.user_id
     WHERE ($1 = '' OR c.status = $1)
       AND ($2 = '' OR u.email ILIKE $3 OR u.fund_id ILIKE $3 OR coalesce(u.display_name, '') ILIKE $3
            OR c.reference ILIKE $3 OR c.asset ILIKE $3 OR c.network ILIKE $3
            OR c.id::text = $2 OR u.id::text = $2)
     ORDER BY c.created_at DESC
     LIMIT 80`,
    [filter, query, `%${query}%`],
  );
  return rows.rows.map((row) => ({
    id: Number(row.id),
    userId: Number(row.user_id),
    email: String(row.email),
    fundId: String(row.fund_id),
    name: row.display_name ? String(row.display_name) : "",
    internalTest: Boolean(row.is_internal_test),
    asset: String(row.asset),
    network: String(row.network),
    amount: String(row.amount),
    reference: String(row.reference),
    status: String(row.status),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }));
}
