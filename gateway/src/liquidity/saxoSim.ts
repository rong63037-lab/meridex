import { fromScaled, scalesFor, toScaled } from "./decimal.js";
import { pairPresent, secretValue } from "./envfile.js";
import { saxoSimBase } from "./hosts.js";
import { requestJson } from "./http.js";
import {
  LpError,
  type Fill,
  type LiquidityProvider,
  type LpBalance,
  type PlaceRequest,
  type PlaceResult,
  type ProviderRow,
  type Quote,
} from "./types.js";

/**
 * Saxo OpenAPI SIM. Bearer token, no refresh.
 * Default host https://gateway.saxobank.com/sim/openapi.
 * A 401 is reported as TOKEN_EXPIRED. The live gateway is refused.
 */

const FILE = "saxo-sim.env";
const placed = new Map<string, string>();

export type Probe = { ok: boolean; latencyMs: number; error: string };

function token(): string | null {
  return secretValue(FILE, "SAXO_SIM_TOKEN");
}

function accountKey(): string | null {
  return secretValue(FILE, "SAXO_SIM_ACCOUNT_KEY");
}

export function saxoKeyPresent(): boolean {
  return pairPresent(FILE, ["SAXO_SIM_TOKEN", "SAXO_SIM_ACCOUNT_KEY"]);
}

function parseContract(symbol: string): { assetType: string; uic: number } | null {
  const [assetType, uicText] = symbol.split(":");
  const uic = Number(uicText);
  if (!assetType || !Number.isInteger(uic) || uic <= 0) return null;
  return { assetType, uic };
}

function mapStatus(status: string): PlaceResult["status"] {
  const value = status.toLowerCase();
  if (value.includes("fill")) return "filled";
  if (value.includes("partial")) return "partial";
  if (value.includes("cancel")) return "canceled";
  if (value.includes("expir")) return "expired";
  if (value.includes("reject")) return "rejected";
  return "acked";
}

export class SaxoSim implements LiquidityProvider {
  readonly type = "rest" as const;

  constructor(private readonly row: ProviderRow) {}

  private base(): string {
    const host = saxoSimBase(this.row.baseUrl);
    if (!host.ok) throw new LpError("HOST_REFUSED");
    return host.base;
  }

  private auth(): string {
    const value = token();
    if (!value || !accountKey()) throw new LpError("KEY_MISSING");
    return value;
  }

  private async get(path: string, signal?: AbortSignal) {
    const value = this.auth();
    const res = await requestJson(`${this.base()}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${value}`, accept: "application/json" },
      signal,
    });
    if (res.status === 401) throw new LpError("TOKEN_EXPIRED");
    return res;
  }

  async quote(symbol: string): Promise<Quote | null> {
    const contract = parseContract(symbol);
    if (!contract) return null;
    let res;
    try {
      res = await this.get(`/trade/v1/infoprices?AssetType=${encodeURIComponent(contract.assetType)}&Uic=${contract.uic}`);
    } catch (err) {
      if (err instanceof LpError && err.code === "KEY_MISSING") return null;
      if (err instanceof LpError && err.code === "HOST_REFUSED") return null;
      return null;
    }
    const quote = (res.body as { Quote?: { Bid?: number; Ask?: number } } | null)?.Quote;
    const scale = scalesFor(this.row, symbol);
    const bid = toScaled(String(quote?.Bid ?? ""), scale.price);
    const ask = toScaled(String(quote?.Ask ?? ""), scale.price);
    if (bid == null || ask == null) return null;
    return { symbol, bid, ask, ts: Date.now() };
  }

  subscribe(_symbol: string, _onQuote: (quote: Quote) => void): () => void {
    return () => undefined;
  }

  async place(req: PlaceRequest, signal?: AbortSignal): Promise<PlaceResult> {
    const contract = parseContract(req.symbol);
    if (!contract) throw new LpError("VALIDATION");
    const account = accountKey();
    const value = this.auth();
    const scale = scalesFor(this.row, req.symbol);
    const amount = Number(fromScaled(req.qty, scale.qty));
    const res = await requestJson(`${this.base()}/trade/v2/orders`, {
      method: "POST",
      headers: { authorization: `Bearer ${value}`, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        AccountKey: account,
        Uic: contract.uic,
        AssetType: contract.assetType,
        Amount: amount,
        BuySell: req.side === "buy" ? "Buy" : "Sell",
        OrderType: req.price && req.price > 0n ? "Limit" : "Market",
        OrderPrice: req.price && req.price > 0n ? Number(fromScaled(req.price, scale.price)) : undefined,
        OrderDuration: { DurationType: "DayOrder" },
        ExternalReference: req.clientOrderId,
      }),
      signal,
    });
    if (res.status === 401) throw new LpError("TOKEN_EXPIRED");
    if (res.status === 0) throw new LpError("TIMEOUT");
    const orderId = String((res.body as { OrderId?: string } | null)?.OrderId ?? "");
    if (orderId) placed.set(req.clientOrderId, orderId);
    const rejected = res.status >= 400;
    return {
      clientOrderId: req.clientOrderId,
      providerOrderId: orderId,
      status: rejected ? "rejected" : "acked",
      filledQty: 0n,
      avgPx: 0n,
      fills: [],
      rejectReason: rejected ? `HTTP_${res.status}` : undefined,
    };
  }

  async cancel(clientOrderId: string): Promise<PlaceResult> {
    const orderId = placed.get(clientOrderId);
    if (!orderId) throw new LpError("NOT_FOUND");
    const value = this.auth();
    const res = await requestJson(`${this.base()}/trade/v2/orders/${encodeURIComponent(orderId)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${value}`, accept: "application/json" },
    });
    if (res.status === 401) throw new LpError("TOKEN_EXPIRED");
    return {
      clientOrderId,
      providerOrderId: orderId,
      status: res.status >= 400 ? "rejected" : "canceled",
      filledQty: 0n,
      avgPx: 0n,
      fills: [],
    };
  }

  async status(clientOrderId: string): Promise<PlaceResult | null> {
    const res = await this.get("/port/v1/orders/me?$top=50");
    const data = (res.body as { Data?: { OrderId?: string; ExternalReference?: string; Status?: string }[] } | null)?.Data ?? [];
    const hit = data.find((row) => row.ExternalReference === clientOrderId || row.OrderId === placed.get(clientOrderId));
    if (!hit) return null;
    return {
      clientOrderId,
      providerOrderId: String(hit.OrderId ?? ""),
      status: mapStatus(String(hit.Status ?? "")),
      filledQty: 0n,
      avgPx: 0n,
      fills: [],
    };
  }

  async fills(): Promise<Fill[]> {
    return [];
  }

  async balances() {
    const res = await this.get("/port/v1/balances/me");
    const row = res.body as { CashBalance?: number; Currency?: string } | null;
    const qty = toScaled(String(row?.CashBalance ?? ""), 1_000_000);
    if (!row?.Currency || qty == null) return [];
    return [{ asset: row.Currency, qty }];
  }

  async positions() {
    const res = await this.get("/port/v1/positions/me?$top=20");
    const data = (res.body as { Data?: { NetPositionId?: string; Amount?: number }[] } | null)?.Data ?? [];
    return data.map((row) => ({
      symbol: String(row.NetPositionId ?? ""),
      qty: BigInt(Math.round(Number(row.Amount ?? 0) * 1_000_000)),
    })).filter((row) => row.symbol);
  }

  async heartbeat() {
    if (!saxoKeyPresent()) return { ok: false, detail: "KEY_MISSING" };
    if (!saxoSimBase(this.row.baseUrl).ok) return { ok: false, detail: "HOST_REFUSED" };
    return { ok: false, detail: "NOT_TESTED" };
  }

  /** Read-only balance and info price. Sends no order. A 401 is token expired. */
  async probe(): Promise<Probe> {
    if (!saxoKeyPresent()) return { ok: false, latencyMs: 0, error: "KEY_MISSING" };
    if (!saxoSimBase(this.row.baseUrl).ok) return { ok: false, latencyMs: 0, error: "HOST_REFUSED" };
    const started = Date.now();
    try {
      const bal = await this.get("/port/v1/balances/me");
      if (bal.status !== 200) return { ok: false, latencyMs: Date.now() - started, error: bal.status === 0 ? "UNREACHABLE" : `HTTP_${bal.status}` };
      const symbol = Object.values(this.row.symbolMap)[0] || "FxSpot:21";
      const contract = parseContract(symbol);
      if (!contract) return { ok: false, latencyMs: Date.now() - started, error: "VALIDATION" };
      const px = await this.get(`/trade/v1/infoprices?AssetType=${encodeURIComponent(contract.assetType)}&Uic=${contract.uic}`);
      if (px.status !== 200) return { ok: false, latencyMs: Date.now() - started, error: px.status === 0 ? "UNREACHABLE" : `HTTP_${px.status}` };
      return { ok: true, latencyMs: Date.now() - started, error: "" };
    } catch (err) {
      const code = err instanceof LpError ? err.code : "UNREACHABLE";
      return { ok: false, latencyMs: Date.now() - started, error: code };
    }
  }
}
