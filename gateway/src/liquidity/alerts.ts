import type { Db } from "../db.js";
import { notifyOwner } from "./mark.js";

const recent = new Map<string, number>();

export async function raiseAlert(pool: Db, kind: string, asset: string, detail: Record<string, unknown>) {
  const key = `${kind}:${asset}`;
  const prev = recent.get(key) ?? 0;
  if (Date.now() - prev < 15 * 60_000) return;
  recent.set(key, Date.now());
  await pool.query(`INSERT INTO lp_alerts (kind, asset, detail) VALUES ($1,$2,$3::jsonb)`, [kind, asset, JSON.stringify(detail)]);
  const title =
    kind === "disconnect" ? "流动性连接中断" : kind === "reject_spike" ? "流动性拒绝升高" : kind === "exposure" ? "流动性敞口超限" : "流动性告警";
  await notifyOwner(pool, title, `${asset} ${kind}`);
}

export function clearAlertMemory() {
  recent.clear();
}
