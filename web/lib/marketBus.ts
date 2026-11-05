import type { Book, TapeTrade } from "./api";
import type { Candle } from "./markets";

export type MarketSnap = {
  book: Book | null;
  trades: TapeTrade[];
  candles: Record<string, Candle>;
  sentAt: number;
  recvAt: number;
  engineMs: number;
};

let snap: MarketSnap = { book: null, trades: [], candles: {}, sentAt: 0, recvAt: 0, engineMs: 0 };
const listeners = new Set<() => void>();
let tf = "1m";
let push: ((body: unknown) => void) | null = null;

export function getMarket(): MarketSnap {
  return snap;
}

export function publishMarket(next: Partial<MarketSnap>): void {
  snap = { ...snap, ...next };
  for (const fn of listeners) fn();
}

export function subscribeMarket(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function streamTf(): string {
  return tf;
}

export function setStreamTf(next: string): void {
  if (!next || tf === next) return;
  tf = next;
  push?.({ type: "subscribe", tf: next });
}

export function bindStreamSend(fn: ((body: unknown) => void) | null): void {
  push = fn;
}
