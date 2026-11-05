import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Secrets are read by name only.
 * `secret_ref` is an environment variable name, or a key in the local file
 * `data/lp-secrets.json` (gitignored). The value never goes into the database,
 * an API response, or a log line.
 */

function secretsPath(): string {
  if (process.env.LP_SECRETS_FILE) return process.env.LP_SECRETS_FILE;
  return join(dirname(fileURLToPath(import.meta.url)), "../../../data/lp-secrets.json");
}

function fileValue(name: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(secretsPath(), "utf8")) as Record<string, unknown>;
    const value = parsed[name];
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export type KeyPresence = "unset" | "present" | "missing";

export function keyPresence(secretRef: string): KeyPresence {
  const name = secretRef.trim();
  if (!name) return "unset";
  if (process.env[name]) return "present";
  if (fileValue(name)) return "present";
  return "missing";
}

/** For a future real adapter. Do not log the return value. */
export function readSecret(secretRef: string): string | null {
  const name = secretRef.trim();
  if (!name) return null;
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  return fileValue(name);
}
