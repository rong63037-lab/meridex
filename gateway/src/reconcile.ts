/** One board for today's claims, manual credits, and anything still unmatched. */
import type { Db } from "./db.js";
import { formatScaled } from "./units.js";

export type ReconcileFilter = "today" | "claims" | "credits" | "unmatched";

export type ReconcileRow = {
  kind: "claim" | "credit";
  id: number;
  email: string;
  asset: string;
  network: string;
  amount: string;
  reference: string;
  status: string;
  at: string;
  matched: boolean;
};

const FILTERS: ReconcileFilter[] = ["today", "claims", "credits", "unmatched"];

export function reconcileFilter(raw: string): ReconcileFilter {
  return FILTERS.includes(raw as ReconcileFilter) ? (raw as ReconcileFilter) : "today";
}

export async function reconcileBoard(pool: Db, filter: ReconcileFilter): Promise<ReconcileRow[]> {
  const claims = await pool.query(
    `SELECT c.id, u.email, c.asset, c.network, c.amount, c.reference, c.status, c.created_at,
            EXISTS (
              SELECT 1 FROM manual_deposits m
              WHERE m.claim_id = c.id AND m.reversed_at IS NULL
            ) AS matched
     FROM deposit_claims c
     JOIN users u ON u.id = c.user_id
     WHERE u.is_internal_test = false
       AND (
         $1 = 'claims'
         OR ($1 = 'today' AND c.created_at >= date_trunc('day', now()))
         OR ($1 = 'unmatched' AND c.status = 'pending')
       )
     ORDER BY c.created_at DESC
     LIMIT 200`,
    [filter],
  );
  const credits = await pool.query(
    `SELECT m.id, u.email, m.asset, m.network, m.gross_amount::text, m.decimals, m.reference,
            CASE WHEN m.reversed_at IS NULL THEN 'credited' ELSE 'reversed' END AS status,
            m.created_at, m.claim_id
     FROM manual_deposits m
     JOIN users u ON u.id = m.user_id
     WHERE (
       $1 = 'credits'
       OR ($1 = 'today' AND m.created_at >= date_trunc('day', now()))
       OR ($1 = 'unmatched' AND m.claim_id IS NULL AND m.reversed_at IS NULL AND m.created_at >= date_trunc('day', now()))
     )
     ORDER BY m.created_at DESC
     LIMIT 200`,
    [filter],
  );
  const claimRows: ReconcileRow[] = filter === "credits" ? [] : claims.rows.map((row) => ({
    kind: "claim" as const,
    id: Number(row.id),
    email: String(row.email),
    asset: String(row.asset),
    network: String(row.network),
    amount: String(row.amount),
    reference: String(row.reference),
    status: String(row.status),
    at: new Date(row.created_at as string).toISOString(),
    matched: Boolean(row.matched),
  }));
  const creditRows: ReconcileRow[] = filter === "claims" ? [] : credits.rows.map((row) => {
    const decimals = Number(row.decimals);
    return {
      kind: "credit" as const,
      id: Number(row.id),
      email: String(row.email),
      asset: String(row.asset),
      network: String(row.network),
      amount: formatScaled(BigInt(row.gross_amount as string), decimals, decimals),
      reference: String(row.reference),
      status: String(row.status),
      at: new Date(row.created_at as string).toISOString(),
      matched: row.claim_id != null,
    };
  });
  return [...claimRows, ...creditRows].sort((a, b) => (a.at < b.at ? 1 : -1));
}

function cell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function reconcileCsv(rows: ReconcileRow[]): string {
  const header = "kind,id,email,asset,network,amount,reference,status,at,matched";
  const lines = rows.map((row) =>
    [row.kind, String(row.id), row.email, row.asset, row.network, row.amount, row.reference, row.status, row.at, row.matched ? "yes" : "no"]
      .map(cell)
      .join(","),
  );
  return [header, ...lines].join("\n");
}
