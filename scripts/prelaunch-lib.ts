import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Seed and staff logins the reset may remove. The pool owner is excluded in SQL. */
export const REMOVAL_EMAILS = [
  "client@meridexexchange.com",
  "compliance@meridexexchange.com",
  "mei.tan@meridexexchange.com",
  "harris.ong@meridexexchange.com",
  "farah.lim@meridexexchange.com",
  "hk.chen@meridexexchange.com",
  "jp.sato@meridexexchange.com",
  "th.somchai@meridexexchange.com",
  "ae.nasser@meridexexchange.com",
  "wei.lin@meridexexchange.com",
  "james.walker@meridexexchange.com",
  "aisha.rahman@meridexexchange.com",
  "nadia.karim@meridexexchange.com",
  "bot-mm@internal.meridex",
  "bot-flow@internal.meridex",
  "risk@meridexexchange.com",
  "ops@meridexexchange.com",
  "ops.checker@meridexexchange.com",
  "support@meridexexchange.com",
];

export const SEED_CONTENT = {
  announcements: ["ann-notice", "ann-demo"],
  announcementTitles: ["自审公告"],
  campaigns: ["camp-welcome", "camp-demo"],
  help: ["help-deposit", "help-whitelist", "help-paper", "help-api"],
  tasks: ["task-login", "task-deposit", "task-trade"],
  cases: ["case-wash", "case-demo-wash"],
};

/** Subquery of user ids the reset would remove. Bind the email list as $1. */
export const REMOVAL_IDS = `(SELECT id FROM users WHERE address_pool_owner = false AND (
  is_internal_test
  OR role = 'bot'
  OR email = ANY($1::text[])
  OR email LIKE '%@internal.meridex'
  OR email ~ '^(audit-|wd\\.)'
  OR email LIKE '%.manual.%'
))`;

export function backupDir(): string {
  return process.env.MERIDEX_BACKUP_DIR || path.join(os.homedir(), "meridex", "backups");
}

export type GatewayProc = { pid: number; env: Record<string, string> };

export function findGateway(): GatewayProc | null {
  let names: string[] = [];
  try {
    names = fs.readdirSync("/proc");
  } catch {
    return null;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let cmd = "";
    let cwd = "";
    try {
      cmd = fs.readFileSync(`/proc/${name}/cmdline`).toString("utf8").replace(/\0/g, " ");
      cwd = fs.readlinkSync(`/proc/${name}/cwd`);
    } catch {
      continue;
    }
    if (!cmd.includes("src/index.ts") || !cwd.endsWith(`${path.sep}gateway`)) continue;
    const env: Record<string, string> = {};
    try {
      const raw = fs.readFileSync(`/proc/${name}/environ`);
      for (const item of raw.toString("utf8").split("\0")) {
        if (!item) continue;
        const eq = item.indexOf("=");
        if (eq <= 0) continue;
        env[item.slice(0, eq)] = item.slice(eq + 1);
      }
    } catch {
      continue;
    }
    return { pid: Number(name), env };
  }
  return null;
}

export function databaseUrl(gateway: GatewayProc | null): string {
  return (
    process.env.DATABASE_URL ||
    gateway?.env.DATABASE_URL ||
    "postgres://meridex:<redacted>@127.0.0.1:5432/meridex"
  );
}

export function openPool(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 2 });
}

export function cronText(): string {
  try {
    return execFileSync("crontab", ["-l"], { encoding: "utf8" });
  } catch {
    return "";
  }
}

export function scheduledBackup(): boolean {
  const cron = cronText();
  if (cron.includes("backup-db.sh")) return true;
  const dirs = ["/etc/cron.d", "/etc/systemd/system", path.join(os.homedir(), ".config/systemd/user")];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      let text = "";
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (text.includes("backup-db.sh") || text.includes("com.meridex.backup")) return true;
    }
  }
  return false;
}
