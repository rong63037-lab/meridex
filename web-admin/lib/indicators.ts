import { movingAverage } from "./markets";

export type Studies = { ma: boolean; ema: boolean; boll: boolean; vol: boolean; macd: boolean; rsi: boolean };

export const defaultStudies: Studies = { ma: true, ema: false, boll: false, vol: true, macd: false, rsi: false };

export function ema(values: number[], period: number): (number | null)[] {
  const k = 2 / (period + 1);
  const out: (number | null)[] = [];
  let prev = 0;
  let seed = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      seed += values[i];
      out.push(null);
      continue;
    }
    if (i === period - 1) {
      seed += values[i];
      prev = seed / period;
      out.push(prev);
      continue;
    }
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function bollinger(values: number[], period = 20, mult = 2) {
  const mid = movingAverage(values, period);
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];
  for (let i = 0; i < values.length; i++) {
    if (mid[i] == null) {
      upper.push(null);
      lower.push(null);
      continue;
    }
    let acc = 0;
    for (let j = i - period + 1; j <= i; j++) acc += (values[j] - (mid[i] as number)) ** 2;
    const sd = Math.sqrt(acc / period);
    upper.push((mid[i] as number) + mult * sd);
    lower.push((mid[i] as number) - mult * sd);
  }
  return { mid, upper, lower };
}

export function macd(values: number[]) {
  const fast = ema(values, 12);
  const slow = ema(values, 26);
  const line = values.map((_, i) => (fast[i] != null && slow[i] != null ? (fast[i] as number) - (slow[i] as number) : null));
  const compact = line.map((value) => value ?? 0);
  const signalRaw = ema(compact, 9);
  const signal = line.map((value, i) => (value == null || i < 26 + 8 ? null : signalRaw[i]));
  const hist = line.map((value, i) => (value == null || signal[i] == null ? null : value - (signal[i] as number)));
  return { line, signal, hist };
}

export function rsi(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = [];
  let gain = 0;
  let loss = 0;
  for (let i = 0; i < values.length; i++) {
    if (i === 0) {
      out.push(null);
      continue;
    }
    const diff = values[i] - values[i - 1];
    const up = Math.max(diff, 0);
    const down = Math.max(-diff, 0);
    if (i < period) {
      gain += up;
      loss += down;
      out.push(null);
      continue;
    }
    if (i === period) {
      gain = (gain + up) / period;
      loss = (loss + down) / period;
    } else {
      gain = (gain * (period - 1) + up) / period;
      loss = (loss * (period - 1) + down) / period;
    }
    const rs = loss === 0 ? 100 : gain / loss;
    out.push(loss === 0 ? 100 : 100 - 100 / (1 + rs));
  }
  return out;
}
