import { bindStreamSend, publishMarket, streamTf } from "./marketBus";

export type Book = {
  symbol: string;
  referencePrice: number;
  lastPrice: number | null;
  halted: boolean;
  bandLow: number;
  bandHigh: number;
  bids: { price: number; qty: number; orders: number }[];
  asks: { price: number; qty: number; orders: number }[];
  stateHash: string;
  tradeCount: number;
  priceScale?: number;
  qtyScale?: number;
  quoteScale?: number;
  priceDecimals?: number;
  qtyDecimals?: number;
  base?: string;
  quote?: string;
  category?: string;
};

export type TapeTrade = {
  engine_trade_id: string;
  price_cents: string;
  qty_mg: string;
  notional_uusd: string;
  taker_side: string;
  tape_at: string;
};

export function authHeaders(extra?: Record<string, string>): HeadersInit {
  const token = typeof window === "undefined" ? null : localStorage.getItem("meridex.token");
  const country = typeof window === "undefined" ? null : localStorage.getItem("meridex.country");
  return {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(country ? { "x-mock-country": country } : {}),
    ...extra,
  };
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { ...authHeaders(), ...(init.headers || {}) },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const error = new Error(data.error || "REQUEST_FAILED") as Error & { code: string; status: number };
    error.code = data.error || "REQUEST_FAILED";
    error.status = res.status;
    throw error;
  }
  return data as T;
}

export type Execution = {
  type: "execution";
  tradeId: string;
  side: "buy" | "sell";
  price: number;
  qty: number;
  symbol?: string;
  status: string;
};

export type BalanceMsg = {
  type: "balances";
  balances: {
    USD: { available: string; reserved: string };
    XAU: { available: string; reserved: string };
    entityId: string | null;
    assets?: { asset: string; available: string; reserved: string; usd: string; qtyScale: number; qtyDecimals: number }[];
  };
};

export function connectMarket(
  onBook: (book: Book, trades: TapeTrade[], chart: TapeTrade[]) => void,
  onStatus?: (state: "live" | "down") => void,
  onPrivate?: (msg: Execution | BalanceMsg) => void,
  symbol = "XAU/USD",
): () => void {
  let socket: WebSocket | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let beat: ReturnType<typeof setInterval>;
  let frame = 0;
  let lastMsg = Date.now();
  let delay = 400;
  let pending: { book: Book; trades: TapeTrade[]; chart: TapeTrade[]; candles?: Record<string, { time: number; open: number; high: number; low: number; close: number; volume: number }>; sentAt?: number; engineMs?: number } | null = null;
  const flush = () => {
    frame = 0;
    if (!pending) return;
    const next = pending;
    pending = null;
    const recvAt = Date.now();
    publishMarket({
      book: next.book,
      trades: next.trades,
      candles: next.candles ?? {},
      sentAt: next.sentAt ?? recvAt,
      recvAt,
      engineMs: next.engineMs ?? 0,
    });
    onBook(next.book, next.trades, next.chart);
  };
  const open = () => {
    if (stopped) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const token = localStorage.getItem("meridex.token");
    const q = new URLSearchParams();
    if (token) q.set("token", token);
    if (symbol) q.set("symbol", symbol);
    socket = new WebSocket(`${proto}//${location.host}/ws?${q.toString()}`);
    socket.onopen = () => {
      lastMsg = Date.now();
      delay = 400;
      onStatus?.("live");
      bindStreamSend((body) => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(body));
      });
      socket?.send(JSON.stringify({ type: "subscribe", symbol, tf: streamTf() }));
    };
    socket.onmessage = (ev) => {
      lastMsg = Date.now();
      const msg = JSON.parse(ev.data);
      if (msg.type === "pong") return;
      if (msg.type === "book") {
        onStatus?.("live");
        pending = {
          book: msg.book,
          trades: msg.trades ?? [],
          chart: msg.chart ?? [],
          candles: msg.candles,
          sentAt: msg.sentAt,
          engineMs: msg.engineMs,
        };
        if (!frame) frame = requestAnimationFrame(flush);
        return;
      }
      if (msg.type === "balances" || msg.type === "execution") onPrivate?.(msg);
    };
    socket.onerror = () => onStatus?.("down");
    socket.onclose = () => {
      onStatus?.("down");
      bindStreamSend(null);
      if (!stopped) {
        timer = setTimeout(open, delay);
        delay = Math.min(8000, delay * 2);
      }
    };
  };
  open();
  beat = setInterval(() => {
    if (stopped || !socket) return;
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
    if (Date.now() - lastMsg > 20_000) socket.close();
  }, 15_000);
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(beat);
    if (frame) cancelAnimationFrame(frame);
    bindStreamSend(null);
    socket?.close();
  };
}
