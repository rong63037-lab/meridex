import { LpError, type LiquidityProvider, type PlaceRequest, type PlaceResult, type Quote } from "./types.js";

/**
 * Coinbase Exchange sandbox stub.
 * The sandbox host is recorded on the provider row. Keys are not available,
 * so this class never opens a connection and never sends an order.
 */
export class CoinbaseSandboxStub implements LiquidityProvider {
  readonly type = "rest" as const;

  async quote(_symbol: string): Promise<Quote | null> {
    return null;
  }

  subscribe(_symbol: string, _onQuote: (quote: Quote) => void): () => void {
    return () => undefined;
  }

  async place(_req: PlaceRequest, _signal?: AbortSignal): Promise<PlaceResult> {
    throw new LpError("LP_DOCS_REQUIRED");
  }

  async cancel(_clientOrderId: string): Promise<PlaceResult> {
    throw new LpError("LP_DOCS_REQUIRED");
  }

  async status(_clientOrderId: string): Promise<PlaceResult | null> {
    return null;
  }

  async fills() {
    return [];
  }

  async balances() {
    return [];
  }

  async positions() {
    return [];
  }

  async heartbeat() {
    return { ok: false, detail: "STUB" };
  }

  async probe() {
    return { ok: false, latencyMs: 0, error: "STUB" };
  }
}
