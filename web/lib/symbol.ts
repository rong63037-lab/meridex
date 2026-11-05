/** Canonical instrument identity. Selection is always a symbol string, never a row index. */

export const DEFAULT_SYMBOL = "XAU/USD";
export const SYMBOL_STORAGE_KEY = "meridex.symbol";

export function symbolSlug(symbol: string): string {
  return symbol.trim().replaceAll("/", "-").toLowerCase();
}

/**
 * Exact symbol or exact slug only.
 * `xau` does not match `XAU/USD`. `xau-usd` does not match `XAUKG/USD`. `btc-usd` does not match gold.
 */
export function resolveSymbol(requested: string, catalog: readonly string[]): string | null {
  const raw = requested.trim();
  if (!raw) return null;
  const direct = catalog.find((item) => item.toLowerCase() === raw.toLowerCase());
  if (direct) return direct;
  const slug = symbolSlug(raw);
  const matches = catalog.filter((item) => symbolSlug(item) === slug);
  return matches.length === 1 ? matches[0] : null;
}

export function terminalHref(symbol: string): string {
  return `/terminal?symbol=${encodeURIComponent(symbol)}`;
}

export function marketHref(symbol: string): string {
  return `/markets/${symbolSlug(symbol)}`;
}

export type SymbolRequest = { url: string | null | undefined; stored: string | null | undefined };

export type SymbolChoice = { symbol: string; source: "url" | "stored" | "default"; explicit: boolean };

/**
 * The URL names the instrument. Stored last-symbol is used only when the URL does not.
 * `XAU/USD` is used only when both are empty. A stored value never replaces a requested one,
 * including when the request is not in the catalog yet.
 */
export function chooseSymbol(request: SymbolRequest, catalog: readonly string[]): SymbolChoice {
  const url = request.url?.trim() ?? "";
  if (url) {
    return { symbol: resolveSymbol(url, catalog) ?? url, source: "url", explicit: true };
  }
  const stored = request.stored?.trim() ?? "";
  if (stored) {
    return { symbol: resolveSymbol(stored, catalog) ?? stored, source: "stored", explicit: false };
  }
  return { symbol: DEFAULT_SYMBOL, source: "default", explicit: false };
}

/** The open symbol stays in the control even when a filter hides it, so the control cannot snap to the first row. */
export function pickerSymbols(filtered: readonly string[], active: string): string[] {
  if (!active || filtered.includes(active)) return [...filtered];
  return [active, ...filtered];
}

export function rowTargets(rows: readonly { symbol: string }[]): { symbol: string; href: string }[] {
  return rows.map((row) => ({ symbol: row.symbol, href: terminalHref(row.symbol) }));
}

/** Ignore a ticker response that belongs to an older slug. A late gold lookup must not replace BTC. */
export function takeLookup(generation: number, current: number, slug: string, symbols: readonly string[]): string | null {
  if (generation !== current) return null;
  return resolveSymbol(slug, symbols);
}

/** Live re-sort changes position, not which symbol is selected. */
export function selectedAfterResort(selected: string, rows: readonly { symbol: string }[]): string {
  return rows.some((row) => row.symbol === selected) ? selected : selected;
}
