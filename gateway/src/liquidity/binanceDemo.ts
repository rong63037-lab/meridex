import { createHmac } from "node:crypto";
import { fromScaled, scalesFor, toScaled } from "./decimal.js";
import { pairPresent, secretValue } from "./envfile.js";
import { binanceDemoBase } from "./hosts.js";
import { requestJson } from "./http.js";
import {
  LpError,
  type Fill,
  type LiquidityProvider,
  type LpBalance,
  type LpPosition,
  type PlaceRequest,
  type PlaceResult,
  type ProviderRow,
  type Quote,
} from "./types.js";

/**
 * Binance Demo Trading, USDS-M futures.
 * Default host https://demo-fapi.binance.com (demo.binance.com keys).
 * HMAC SHA256. Production and the old testnet host are refused.
 */

const FILE = "binance-demo.env";
const placed = new Map<string, { symbol: string; orderId: string }>();

export type Probe = { ok: boolean; latencyMs: number; error: string };

function keys(): { key: string; secret: string } | null {
  const key = secretValue(FILE, "BINANCE_DEMO_API_KEY");
  const secret = secretValue(FILE, "BINANCE_DEMO_API_SECRET");
  if (!key || !secret) return null;
  return { key, secret };
}

export function binanceKeyPresent(): boolean {
  return pairPresent(FILE, ["BINANCE_DEMO_API_KEY", "BINANCE_DEMO_API_SECRET"]);
}

function sign(secret: string, query: string): string {
  return createHmac("sha256", secret).update(query).digest("hex");
}

function signedQuery(secret: string, params: Record<string, string>): string {
  const body = new URLSearchParams(params);
  body.set("timestamp", String(Date.now()));
  body.set("recvWindow", "5000");
  const query = body.toString();
  return `${query}&signature=${sign(secret, query)}`;
}

function mapStatus(status: string): PlaceResult["status"] {
  if (status === "FILLED") return "filled";
  if (status === "PARTIALLY_FILLED") return "partial";
  if (status === "CANCELED" || status === "CANCELLED") return "canceled";
  if (status === "EXPIRED") return "expired";
  if (status === "REJECTED") return "rejected";
  if (status === "NEW") return "acked";
  return "acked";
}

function orderResult(clientOrderId: string, body: unknown, scale: { qty: number; price: number }): PlaceResult {
  const row = body as { orderId?: number | string; status?: string; executedQty?: string; avgPrice?: string; code?: number };
  const filled = toScaled(String(row.executedQty ?? "0"), scale.qty) ?? 0n;
  const avg = toScaled(String(row.avgPrice ?? "0"), scale.price) ?? 0n;
  const status = mapStatus(String(row.status ?? ""));
  const orderId = row.orderId != null ? String(row.orderId) : "";
  const fills: Fill[] = filled > 0n && avg > 0n ? [{ fillId: orderId || clientOrderId, qty: filled, px: avg, ts: Date.now() }] : [];
  return {
    clientOrderId,
    providerOrderId: orderId,
    status: row.code ? "rejected" : status,
    filledQty: filled,
    avgPx: avg,
    fills,
    rejectReason: row.code ? `BINANCE_${row.code}` : undefined,
  };
}

export class BinanceDemoFutures implements LiquidityProvider {
  readonly type = "rest" as const;

  constructor(private readonly row: ProviderRow) {}

  private base(): string {
    const host = binanceDemoBase(this.row.baseUrl);
    if (!host.ok) throw new LpError("HOST_REFUSED");
    return host.base;
  }

  private creds() {
    const found = keys();
    if (!found) throw new LpError("KEY_MISSING");
    return found;
  }

  async quote(symbol: string): Promise<Quote | null> {
    let base: string;
    try {
      base = this.base();
    } catch {
      return null;
    }
    const scale = scalesFor(this.row, symbol);
    const res = await requestJson(`${base}/fapi/v1/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`, { method: "GET" });
    const row = res.body as { bidPrice?: string; askPrice?: string } | null;
    const bid = toScaled(String(row?.bidPrice ?? ""), scale.price);
    const ask = toScaled(String(row?.askPrice ?? ""), scale.price);
    if (bid == null || ask == null) return null;
    return { symbol, bid, ask, ts: Date.now() };
  }

  subscribe(_symbol: string, _onQuote: (quote: Quote) => void): () => void {
    return () => undefined;
  }

  async place(req: PlaceRequest, signal?: AbortSignal): Promise<PlaceResult> {
    const base = this.base();
    const creds = this.creds();
    const scale = scalesFor(this.row, req.symbol);
    const params: Record<string, string> = {
      symbol: req.symbol,
      side: req.side === "buy" ? "BUY" : "SELL",
      type: req.price && req.price > 0n ? "LIMIT" : "MARKET",
      quantity: fromScaled(req.qty, scale.qty),
      newClientOrderId: req.clientOrderId,
    };
    if (params.type === "LIMIT" && req.price) {
      params.price = fromScaled(req.price, scale.price);
      params.timeInForce = "GTC";
    }
    const query = signedQuery(creds.secret, params);
    const res = await requestJson(`${base}/fapi/v1/order?${query}`, {
      method: "POST",
      headers: { "X-MBX-APIKEY": creds.key },
      signal,
    });
    if (res.status === 0) throw new LpError("TIMEOUT");
    const result = orderResult(req.clientOrderId, res.body, scale);
    if (res.status >= 400 && !result.rejectReason) result.status = "rejected";
    if (result.providerOrderId) placed.set(req.clientOrderId, { symbol: req.symbol, orderId: result.providerOrderId });
    else placed.set(req.clientOrderId, { symbol: req.symbol, orderId: "" });
    return result;
  }

  async cancel(clientOrderId: string): Promise<PlaceResult> {
    const known = placed.get(clientOrderId);
    if (!known?.symbol) throw new LpError("NOT_FOUND");
    const base = this.base();
    const creds = this.creds();
    const query = signedQuery(creds.secret, { symbol: known.symbol, origClientOrderId: clientOrderId });
    const res = await requestJson(`${base}/fapi/v1/order?${query}`, {
      method: "DELETE",
      headers: { "X-MBX-APIKEY": creds.key },
    });
    return orderResult(clientOrderId, res.body, scalesFor(this.row, known.symbol));
  }

  async status(clientOrderId: string): Promise<PlaceResult | null> {
    const known = placed.get(clientOrderId);
    if (!known?.symbol) return null;
    const base = this.base();
    const creds = this.creds();
    const query = signedQuery(creds.secret, { symbol: known.symbol, origClientOrderId: clientOrderId });
    const res = await requestJson(`${base}/fapi/v1/order?${query}`, {
      method: "GET",
      headers: { "X-MBX-APIKEY": creds.key },
    });
    if (res.status === 0 || res.body == null) return null;
    return orderResult(clientOrderId, res.body, scalesFor(this.row, known.symbol));
  }

  async fills(): Promise<Fill[]> {
    return [];
  }

  async balances(): Promise<LpBalance[]> {
    const base = this.base();
    const creds = this.creds();
    const query = signedQuery(creds.secret, {});
    const res = await requestJson(`${base}/fapi/v2/balance?${query}`, {
      method: "GET",
      headers: { "X-MBX-APIKEY": creds.key },
    });
    if (!Array.isArray(res.body)) return [];
    const out: LpBalance[] = [];
    for (const item of res.body) {
      const row = item as { asset?: string; availableBalance?: string };
      const qty = toScaled(String(row.availableBalance ?? ""), 100_000_000);
      if (!row.asset || qty == null) continue;
      out.push({ asset: row.asset, qty });
    }
    return out;
  }

  async positions(): Promise<LpPosition[]> {
    const base = this.base();
    const creds = this.creds();
    const query = signedQuery(creds.secret, {});
    const res = await requestJson(`${base}/fapi/v2/positionRisk?${query}`, {
      method: "GET",
      headers: { "X-MBX-APIKEY": creds.key },
    });
    if (!Array.isArray(res.body)) return [];
    const out: LpPosition[] = [];
    for (const item of res.body) {
      const row = item as { symbol?: string; positionAmt?: string };
      if (!row.symbol || !row.positionAmt || row.positionAmt === "0") continue;
      const qty = toScaled(row.positionAmt.replace("-", ""), 100_000_000);
      if (qty == null) continue;
      out.push({ symbol: row.symbol, qty: row.positionAmt.startsWith("-") ? -qty : qty });
    }
    return out;
  }

  async heartbeat() {
    if (!binanceKeyPresent()) return { ok: false, detail: "KEY_MISSING" };
    if (!binanceDemoBase(this.row.baseUrl).ok) return { ok: false, detail: "HOST_REFUSED" };
    return { ok: false, detail: "NOT_TESTED" };
  }

  /** Read-only: public book plus signed balance. Sends no order. A non-200 is not success. */
  async probe(): Promise<Probe> {
    if (!binanceKeyPresent()) return { ok: false, latencyMs: 0, error: "KEY_MISSING" };
    const host = binanceDemoBase(this.row.baseUrl);
    if (!host.ok) return { ok: false, latencyMs: 0, error: "HOST_REFUSED" };
    const creds = keys();
    if (!creds) return { ok: false, latencyMs: 0, error: "KEY_MISSING" };
    const started = Date.now();
    const symbol = this.row.symbolMap["BTC/USD"] || "BTCUSDT";
    const book = await requestJson(`${host.base}/fapi/v1/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`, { method: "GET" });
    if (book.status !== 200) return { ok: false, latencyMs: Date.now() - started, error: binanceErrorCode(book.body, book.status) };
    const query = signedQuery(creds.secret, {});
    const bal = await requestJson(`${host.base}/fapi/v2/balance?${query}`, {
      method: "GET",
      headers: { "X-MBX-APIKEY": creds.key },
    });
    if (bal.status !== 200 || !Array.isArray(bal.body)) {
      return { ok: false, latencyMs: Date.now() - started, error: binanceErrorCode(bal.body, bal.status === 200 ? 0 : bal.status) };
    }
    return { ok: true, latencyMs: Date.now() - started, error: "" };
  }
}

export function binanceErrorCode(body: unknown, status: number): string {
  const code = (body as { code?: number } | null)?.code;
  if (typeof code === "number") return `BINANCE_${code}`;
  if (status === 0) return "UNREACHABLE";
  return `HTTP_${status}`;
}
