const warned = new Map<string, number>();

export function transientNet(err: unknown): boolean {
  const code = err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
  const msg = err instanceof Error ? err.message : String(err);
  return /socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|aborted|fetch failed|UND_ERR/i.test(`${code} ${msg}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One line at a time, so a dead socket does not fill the log. */
export function quietWarn(key: string, line: string, everyMs = 30_000): void {
  const now = Date.now();
  if (now - (warned.get(key) ?? 0) < everyMs) return;
  warned.set(key, now);
  console.warn(line);
}
