import { LpError, type LiquidityProvider, type PlaceRequest, type PlaceResult, type ProviderRow, type Quote } from "./types.js";

/**
 * FIX-ready skeleton.
 *
 * A live session needs the counterparty's own specification: BeginString,
 * SenderCompID, TargetCompID, the data dictionary, and sequence-reset rules.
 * This file does not invent those messages, tags, or a session, and it does
 * not open a socket. `place` and `cancel` throw LP_DOCS_REQUIRED until that
 * specification is implemented in a follow-up.
 */
export class FixSkeleton implements LiquidityProvider {
  readonly type = "fix" as const;

  constructor(private readonly _row: ProviderRow) {}

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
    return { ok: false, detail: "LP_DOCS_REQUIRED" };
  }
}
