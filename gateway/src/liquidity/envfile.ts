import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Local key files live outside the repo and outside the database.
 * MERIDEX_SECRETS_DIR overrides the directory for tests only.
 * Never log or return the values from this module.
 */

export function secretsDir(): string {
  const override = process.env.MERIDEX_SECRETS_DIR?.trim();
  if (override) return override;
  return join(homedir(), ".meridex-secrets");
}

export function readEnvFile(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key && value) out[key] = value;
  }
  return out;
}

/** Environment first, then the named file. Empty values count as missing. */
export function secretValue(fileName: string, key: string): string | null {
  const fromEnv = process.env[key];
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  const file = readEnvFile(join(secretsDir(), fileName));
  const value = file[key];
  return value && value.trim() ? value.trim() : null;
}

export function pairPresent(fileName: string, keys: string[]): boolean {
  return keys.every((key) => secretValue(fileName, key));
}

export function redact(text: string, secrets: Array<string | null | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out.slice(0, 160);
}
