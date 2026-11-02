import { LpError, type LiquidityProvider, type PlaceRequest, type PlaceResult, type ProviderRow, type Quote } from "./types.js";

/**
 * Generic REST and WebSocket skeleton.
 *
 * This does not speak any firm's API. Do not add paths, payloads, or
 * authentication for a named venue here. Implement `place`, `cancel`, and the
 * stream only after that firm's written API documentation is in the repo's
 * follow-up notes. Until then every mutating call throws LP_DOCS_REQUIRED
 * and nothing is sent.
 */
export class RestSkeleton implements LiquidityProvider {
  readonly type = "rest" as const;

  constructor(private readonly row: ProviderRow) {}

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

  async fills(): Promise<PlaceResult["fills"]> {
    return [];
  }

  async balances() {
    return [];
  }

  async positions() {
    return [];
  }

  async heartbeat() {
    return {
      ok: false,
      detail: this.row.baseUrl ? "LP_DOCS_REQUIRED" : "LP_DOCS_REQUIRED",
    };
  }
}
