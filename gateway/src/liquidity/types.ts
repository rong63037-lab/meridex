/**
 * Internal liquidity-provider contract.
 * Prices and quantities are integers in the instrument's own scales.
 * A driver speaks one firm's protocol. This file does not name a firm.
 */

export type LpType = "mock" | "rest" | "fix";
export type LpMode = "off" | "shadow" | "live";
export type Venue = "spot" | "convert" | "margin" | "perp";
export type Side = "buy" | "sell";

export type LpStatus =
  | "acked"
  | "rejected"
  | "partial"
  | "filled"
  | "canceled"
  | "expired"
  | "disconnected"
  | "timeout";

export class LpError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export type Quote = {
  symbol: string;
  bid: bigint;
  ask: bigint;
  ts: number;
};

export type PlaceRequest = {
  clientOrderId: string;
  symbol: string;
  side: Side;
  qty: bigint;
  price: bigint | null;
};

export type Fill = {
  fillId: string;
  qty: bigint;
  px: bigint;
  ts: number;
};

export type PlaceResult = {
  clientOrderId: string;
  providerOrderId: string;
  status: LpStatus;
  filledQty: bigint;
  avgPx: bigint;
  fills: Fill[];
  rejectReason?: string;
};

export type LpBalance = { asset: string; qty: bigint };
export type LpPosition = { symbol: string; qty: bigint };

export interface LiquidityProvider {
  readonly type: LpType;
  quote(symbol: string): Promise<Quote | null>;
  subscribe(symbol: string, onQuote: (quote: Quote) => void): () => void;
  place(req: PlaceRequest, signal?: AbortSignal): Promise<PlaceResult>;
  cancel(clientOrderId: string): Promise<PlaceResult>;
  status(clientOrderId: string): Promise<PlaceResult | null>;
  fills(since?: number): Promise<Fill[]>;
  balances(): Promise<LpBalance[]>;
  positions(): Promise<LpPosition[]>;
  heartbeat(): Promise<{ ok: boolean; detail: string }>;
}

export type ProviderRow = {
  id: number;
  name: string;
  type: LpType;
  baseUrl: string;
  secretRef: string;
  enabled: boolean;
  mode: LpMode;
  priority: number;
  spreadMarkupBps: number;
  minQty: bigint;
  maxQty: bigint;
  perOrderNotionalUusd: bigint;
  dailyNotionalUusd: bigint;
  symbolMap: Record<string, string>;
};

export function mapSymbol(row: ProviderRow, symbol: string): string {
  const mapped = row.symbolMap[symbol];
  return mapped && mapped.trim() ? mapped : symbol;
}

export function applyMarkup(px: bigint, side: Side, bps: number): bigint {
  if (px <= 0n || bps <= 0) return px;
  const num = side === "buy" ? 10_000n + BigInt(bps) : 10_000n - BigInt(bps);
  const next = (px * num) / 10_000n;
  return next > 0n ? next : 1n;
}

export function terminalZero(status: LpStatus): boolean {
  return status === "rejected" || status === "disconnected" || status === "timeout" || status === "expired" || status === "canceled";
}
