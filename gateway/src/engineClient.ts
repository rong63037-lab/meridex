import http from "node:http";
import { sleep, transientNet } from "./net.js";

export type BookLevel = { price: number; qty: number; orders: number };

export type EngineBook = {
  symbol: string;
  reference_price: number;
  band_bps: number;
  halt_bps: number;
  band_low: number;
  band_high: number;
  halt_low: number;
  halt_high: number;
  halted: boolean;
  state_hash: string;
  command_seq: number;
  trade_count: number;
  last_trade_price: number | null;
  bids: BookLevel[];
  asks: BookLevel[];
};

export type EngineEvent = {
  type: string;
  order_id?: string;
  reason?: string;
  user_id?: number;
  side?: string;
  order_type?: string;
  price?: number | null;
  qty?: number;
  leaves?: number;
  filled?: number;
  trade_id?: number;
  taker_order_id?: string;
  maker_order_id?: string;
  taker_user_id?: number;
  maker_user_id?: number;
  taker_side?: string;
  buyer_user_id?: number;
  seller_user_id?: number;
  buyer_order_id?: string;
  seller_order_id?: string;
};

export type EngineResult = { seq: number; events: EngineEvent[]; state_hash: string };

export class EngineClient {
  private agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private baseUrl: string) {}

  health(symbol = "XAU/USD"): Promise<EngineBook> {
    if (symbol === "XAU/USD") return this.queued("GET", "/health");
    return this.queued("GET", `/books/health?symbol=${encodeURIComponent(symbol)}`);
  }

  book(symbol = "XAU/USD"): Promise<EngineBook> {
    if (symbol === "XAU/USD") return this.queued("GET", "/book");
    return this.queued("GET", `/books/view?symbol=${encodeURIComponent(symbol)}`);
  }

  command(body: unknown, symbol = "XAU/USD"): Promise<EngineResult> {
    if (symbol === "XAU/USD") return this.queued("POST", "/command", body);
    return this.queued("POST", "/books/command", { symbol, command: body });
  }

  order(id: string, symbol = "XAU/USD"): Promise<{ found: boolean; resting: boolean; leaves: number; events: EngineEvent[] }> {
    if (symbol === "XAU/USD") return this.queued("GET", `/order/${encodeURIComponent(id)}`);
    return this.queued("GET", `/books/order?symbol=${encodeURIComponent(symbol)}&id=${encodeURIComponent(id)}`);
  }

  replayVerify(): Promise<{ ok: boolean; state_hash?: string; error?: string }> {
    return this.queued("POST", "/replay-verify", {});
  }

  replayAll(): Promise<{ ok: boolean; books?: { symbol: string; state_hash: string }[]; error?: string }> {
    return this.queued("POST", "/books/replay", {});
  }

  summaries(): Promise<{ books: { symbol: string; state_hash: string; reference_price: number; last_trade_price: number | null; halted: boolean; trade_count: number; band_low: number; band_high: number }[] }> {
    return this.queued("GET", "/books");
  }

  private queued<T>(method: string, path: string, body?: unknown): Promise<T> {
    const run = this.chain.then(() => this.once<T>(method, path, body));
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private once<T>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const url = new URL(path, this.baseUrl);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          method,
          agent: this.agent,
          headers: {
            "content-type": "application/json",
            ...(payload ? { "content-length": String(payload.length) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c as Buffer));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            if ((res.statusCode ?? 500) >= 400) {
              reject(new Error(`ENGINE_${res.statusCode}:${text}`));
              return;
            }
            try {
              resolve(JSON.parse(text) as T);
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.on("error", (err) => {
        this.agent.destroy();
        this.agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
        if (method === "GET" && attempt < 2 && transientNet(err)) {
          void sleep(80 * (attempt + 1)).then(() => this.once<T>(method, path, body, attempt + 1).then(resolve, reject));
          return;
        }
        reject(err);
      });
      if (payload) req.write(payload);
      req.end();
    });
  }
}
