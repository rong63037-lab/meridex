export type FeedReport = {
  ok: boolean;
  updatedAt: string | null;
  sources: Record<string, number>;
  lastError: string | null;
  candles: { source: "binance" | "local" | "unknown"; lastError: string | null };
};

let sources: Record<string, number> = {};
let updatedAt: string | null = null;
let lastError: string | null = null;
let candleSource: FeedReport["candles"]["source"] = "unknown";
let candleError: string | null = null;

export function noteFeeds(counts: Record<string, number> | null, error: string | null): void {
  if (counts) {
    sources = { ...counts };
    updatedAt = new Date().toISOString();
  }
  lastError = error;
}

export function noteCandles(source: "binance" | "local", error: string | null): void {
  candleSource = source;
  candleError = error;
}

export function feedReport(): FeedReport {
  const priced = Object.values(sources).reduce((sum, n) => sum + n, 0);
  return {
    ok: priced > 0,
    updatedAt,
    sources,
    lastError,
    candles: { source: candleSource, lastError: candleError },
  };
}
