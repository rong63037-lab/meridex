import type { Fill, LiquidityProvider, PlaceRequest, PlaceResult, Quote } from "./types.js";

export type MockScenario = "fill" | "partial" | "reject" | "disconnect" | "timeout";

/**
 * In-process provider for tests. No network.
 * The same client order id returns the same order. The same fill id is stored once.
 */
export class MockLiquidityProvider implements LiquidityProvider {
  readonly type = "mock" as const;
  scenario: MockScenario = "fill";
  latencyMs = 0;
  disconnected = false;
  placeCount = 0;
  quotePx: bigint | null = null;
  private orders = new Map<string, PlaceResult>();
  private fillIds = new Set<string>();
  private storedFills: Fill[] = [];
  private net = new Map<string, bigint>();

  constructor(private readonly name = "mock") {}

  private price(symbol: string): bigint {
    if (this.quotePx && this.quotePx > 0n) return this.quotePx;
    let hash = 0;
    for (const ch of symbol) hash = (hash * 33 + ch.charCodeAt(0)) >>> 0;
    return BigInt(50_000_000 + (hash % 1_000_000));
  }

  async quote(symbol: string): Promise<Quote> {
    const mid = this.price(symbol);
    return { symbol, bid: mid > 1n ? mid - 1n : mid, ask: mid + 1n, ts: Date.now() };
  }

  subscribe(symbol: string, onQuote: (quote: Quote) => void): () => void {
    void this.quote(symbol).then(onQuote);
    return () => undefined;
  }

  async place(req: PlaceRequest, signal?: AbortSignal): Promise<PlaceResult> {
    this.placeCount += 1;
    const existing = this.orders.get(req.clientOrderId);
    if (existing) return existing;
    if (this.latencyMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.latencyMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (signal?.aborted || this.scenario === "timeout") return this.remember(this.empty(req, "timeout", "TIMEOUT"));
    if (this.disconnected || this.scenario === "disconnect") return this.remember(this.empty(req, "disconnected", "DISCONNECTED"));
    if (this.scenario === "reject") return this.remember(this.empty(req, "rejected", "REJECTED"));
    const quote = await this.quote(req.symbol);
    const px = req.price ?? (req.side === "buy" ? quote.ask : quote.bid);
    const qty = this.scenario === "partial" ? req.qty / 2n : req.qty;
    if (qty <= 0n) return this.remember(this.empty(req, "rejected", "REJECTED"));
    const fill = this.ingestFill({ fillId: `f:${req.clientOrderId}:1`, qty, px, ts: Date.now() });
    const result: PlaceResult = {
      clientOrderId: req.clientOrderId,
      providerOrderId: `mock:${this.name}:${req.clientOrderId}`,
      status: qty === req.qty ? "filled" : "partial",
      filledQty: fill ? qty : 0n,
      avgPx: px,
      fills: fill ? [fill] : [],
    };
    if (fill) this.addNet(req.symbol, req.side === "buy" ? qty : -qty);
    return this.remember(result);
  }

  async cancel(clientOrderId: string): Promise<PlaceResult> {
    const existing = this.orders.get(clientOrderId);
    if (!existing) return this.empty({ clientOrderId, symbol: "", side: "buy", qty: 0n, price: null }, "rejected", "NOT_FOUND");
    if (existing.status === "filled" || existing.status === "partial") return existing;
    const canceled: PlaceResult = { ...existing, status: "canceled" };
    this.orders.set(clientOrderId, canceled);
    return canceled;
  }

  async status(clientOrderId: string): Promise<PlaceResult | null> {
    return this.orders.get(clientOrderId) ?? null;
  }

  async fills(since = 0): Promise<Fill[]> {
    return this.storedFills.filter((fill) => fill.ts >= since);
  }

  async balances() {
    return [...this.net.entries()].map(([asset, qty]) => ({ asset, qty }));
  }

  async positions() {
    return [...this.net.entries()].map(([symbol, qty]) => ({ symbol, qty }));
  }

  async heartbeat() {
    const down = this.disconnected || this.scenario === "disconnect";
    return { ok: !down, detail: down ? "disconnected" : "ok" };
  }

  /** Second call with the same fill id is ignored. */
  ingestFill(fill: Fill): Fill | null {
    if (this.fillIds.has(fill.fillId)) return null;
    this.fillIds.add(fill.fillId);
    this.storedFills.push(fill);
    return fill;
  }

  private remember(result: PlaceResult): PlaceResult {
    this.orders.set(result.clientOrderId, result);
    return result;
  }

  private empty(req: PlaceRequest, status: PlaceResult["status"], reason: string): PlaceResult {
    return {
      clientOrderId: req.clientOrderId,
      providerOrderId: "",
      status,
      filledQty: 0n,
      avgPx: 0n,
      fills: [],
      rejectReason: reason,
    };
  }

  private addNet(symbol: string, delta: bigint) {
    this.net.set(symbol, (this.net.get(symbol) ?? 0n) + delta);
  }
}
