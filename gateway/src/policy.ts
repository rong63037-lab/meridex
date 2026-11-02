import type { Db } from "./db.js";
import { ensureCoverage } from "./coverage.js";
import { type Access, type Policy } from "./kyc.js";

export async function loadPolicy(pool: Db): Promise<Policy> {
  const rows = await pool.query(
    `SELECT country, access, entity_id FROM jurisdiction_access ORDER BY country`,
  );
  const byCountry: Policy["byCountry"] = {};
  for (const row of rows.rows) {
    byCountry[row.country] = {
      country: row.country,
      access: row.access,
      entityId: row.entity_id,
    };
  }
  return { byCountry };
}

export async function ensurePolicy(pool: Db): Promise<Policy> {
  await ensureCoverage(pool);
  return loadPolicy(pool);
}

export function entityFor(country: string, access: Access, current: string | null): string | null {
  if (access === "block") return null;
  if (country === "MY") return "MY-ENTITY";
  if (access === "allow" || access === "pending") return current && current !== "MY-ENTITY" ? current : "SG-OPCO";
  return current;
}
