"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import { bollinger, ema, macd, rsi, type Studies } from "@/lib/indicators";
import { getMarket, subscribeMarket } from "@/lib/marketBus";
import { formatPct, formatPx, movingAverage, type Candle } from "@/lib/markets";

export type DrawKind = "trend" | "hline" | "fib";
type Drawing = { id: string; kind: DrawKind; a: { time: number; price: number }; b: { time: number; price: number } };
type Point = { time: number; price: number };

type Props = {
  bars: Candle[];
  volumes?: (number | null)[] | null;
  symbol: string;
  priceDecimals?: number;
  tf?: string;
  studies: Studies;
  drawMode: DrawKind | "none";
  clearDraw: number;
  fitKey: string;
  onOlder?: () => void;
};

type Handle = {
  chart: IChartApi;
  candle: ISeriesApi<"Candlestick">;
  volume: ISeriesApi<"Histogram">;
  maFast: ISeriesApi<"Line">;
  maSlow: ISeriesApi<"Line">;
  emaLine: ISeriesApi<"Line">;
  bollMid: ISeriesApi<"Line">;
  bollUp: ISeriesApi<"Line">;
  bollDn: ISeriesApi<"Line">;
};

function lineData(bars: Candle[], values: (number | null)[]) {
  return bars.flatMap((bar, i) => (values[i] == null ? [] : [{ time: bar.time as UTCTimestamp, value: values[i] as number }]));
}

function CandleChartInner({ bars, volumes, symbol, priceDecimals = 2, tf = "1m", studies, drawMode, clearDraw, fitKey, onOlder }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLCanvasElement>(null);
  const api = useRef<Handle | null>(null);
  const drawings = useRef<Drawing[]>([]);
  const pending = useRef<Point | null>(null);
  const barsRef = useRef(bars);
  barsRef.current = bars;
  const volumesRef = useRef(volumes);
  volumesRef.current = volumes;
  const studiesRef = useRef(studies);
  studiesRef.current = studies;
  const [ready, setReady] = useState(0);
  const [hoveredTime, setHoveredTime] = useState<number | null>(null);
  const [liveBar, setLiveBar] = useState<Candle | null>(null);
  const fitted = useRef("");
  const lastBar = useRef<Candle | null>(null);
  const onOlderRef = useRef(onOlder);
  onOlderRef.current = onOlder;
  const barCount = useRef(0);
  barCount.current = bars.length;
  const painted = useRef(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let dead = false;
    let chart: IChartApi | null = null;
    void import("lightweight-charts").then((lc) => {
      if (dead || !host.current) return;
      chart = lc.createChart(host.current, {
        autoSize: true,
        layout: { background: { color: "transparent" }, textColor: "#9AA3B2", fontFamily: "IBM Plex Mono, ui-monospace, monospace" },
        grid: { vertLines: { color: "rgba(245,213,138,0.05)" }, horzLines: { color: "rgba(245,213,138,0.05)" } },
        rightPriceScale: { borderColor: "rgba(245,213,138,0.16)" },
        timeScale: { borderColor: "rgba(245,213,138,0.16)", timeVisible: true, secondsVisible: false },
        crosshair: { mode: 0 },
      });
      const candle = chart.addCandlestickSeries({
        upColor: "#3DDC97",
        downColor: "#FF5D6C",
        borderUpColor: "#3DDC97",
        borderDownColor: "#FF5D6C",
        wickUpColor: "#3DDC97",
        wickDownColor: "#FF5D6C",
      });
      const volume = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol" });
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
      const maFast = chart.addLineSeries({ color: "#F5D58A", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      const maSlow = chart.addLineSeries({ color: "#7FD4E8", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      const emaLine = chart.addLineSeries({ color: "#E7C4FF", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      const bollUp = chart.addLineSeries({ color: "rgba(201,162,75,0.7)", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      const bollMid = chart.addLineSeries({ color: "rgba(201,162,75,0.35)", lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false });
      const bollDn = chart.addLineSeries({ color: "rgba(201,162,75,0.7)", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      api.current = { chart, candle, volume, maFast, maSlow, emaLine, bollMid, bollUp, bollDn };
      let paintFrame = 0;
      const paint = () => {
        if (paintFrame) return;
        paintFrame = requestAnimationFrame(() => {
          paintFrame = 0;
          drawOverlay();
        });
      };
      chart.timeScale().subscribeVisibleTimeRangeChange(paint);
      chart.subscribeCrosshairMove((param) => {
        setHoveredTime(typeof param.time === "number" ? param.time : null);
      });
      chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        const count = barCount.current;
        if (range && count > 20 && range.from < 2 && range.to - range.from < count - 5) onOlderRef.current?.();
        paint();
      });
      setReady((n) => n + 1);
    });
    return () => {
      dead = true;
      chart?.remove();
      api.current = null;
    };
  }, []);

  useEffect(() => {
    setLiveBar(bars[bars.length - 1] ?? null);
  }, [bars]);

  useEffect(() => {
    setHoveredTime(null);
  }, [symbol, tf]);

  useEffect(() => {
    pending.current = null;
    const raw = localStorage.getItem(`meridex.draw.${symbol}`);
    if (!raw) {
      drawings.current = [];
      drawOverlay();
      return;
    }
    try {
      drawings.current = JSON.parse(raw) as Drawing[];
    } catch {
      drawings.current = [];
    }
    drawOverlay();
  }, [symbol, ready]);

  useEffect(() => {
    if (!clearDraw) return;
    drawings.current = [];
    pending.current = null;
    localStorage.setItem(`meridex.draw.${symbol}`, "[]");
    drawOverlay();
  }, [clearDraw, symbol]);

  useEffect(() => {
    const handle = api.current;
    if (!handle || !bars.length) return;
    handle.candle.applyOptions({
      priceFormat: { type: "price", precision: priceDecimals, minMove: 1 / 10 ** priceDecimals },
    });
    handle.candle.setData(bars.map((bar) => ({ time: bar.time as UTCTimestamp, open: bar.open, high: bar.high, low: bar.low, close: bar.close })));
    const closes = bars.map((bar) => bar.close);
    const useExternal = volumes && volumes.length === bars.length;
    handle.volume.applyOptions({ visible: studies.vol });
    handle.volume.setData(
      studies.vol
        ? bars.flatMap((bar, i) => {
            const value = useExternal ? volumes?.[i] : bar.volume;
            if (value == null || value <= 0) return [];
            return [{ time: bar.time as UTCTimestamp, value, color: bar.close >= bar.open ? "rgba(61,220,151,0.45)" : "rgba(255,93,108,0.4)" }];
          })
        : [],
    );
    const ma7 = movingAverage(closes, 7);
    const ma25 = movingAverage(closes, 25);
    const ema21 = ema(closes, 21);
    const bands = bollinger(closes);
    handle.maFast.applyOptions({ visible: studies.ma });
    handle.maSlow.applyOptions({ visible: studies.ma });
    handle.emaLine.applyOptions({ visible: studies.ema });
    handle.bollUp.applyOptions({ visible: studies.boll });
    handle.bollMid.applyOptions({ visible: studies.boll });
    handle.bollDn.applyOptions({ visible: studies.boll });
    handle.maFast.setData(studies.ma ? lineData(bars, ma7) : []);
    handle.maSlow.setData(studies.ma ? lineData(bars, ma25) : []);
    handle.emaLine.setData(studies.ema ? lineData(bars, ema21) : []);
    handle.bollUp.setData(studies.boll ? lineData(bars, bands.upper) : []);
    handle.bollMid.setData(studies.boll ? lineData(bars, bands.mid) : []);
    handle.bollDn.setData(studies.boll ? lineData(bars, bands.lower) : []);
    lastBar.current = bars[bars.length - 1] ?? null;
    if (fitted.current !== fitKey) {
      handle.chart.timeScale().fitContent();
      fitted.current = fitKey;
    }
    if (!painted.current) {
      painted.current = true;
      performance.mark("meridex-chart-paint");
    }
    drawOverlay();
  }, [bars, volumes, studies, ready, fitKey, priceDecimals]);

  useEffect(() => {
    let frame = 0;
    return subscribeMarket(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const handle = api.current;
        const snap = getMarket();
        if (!handle || snap.book?.symbol !== symbol) return;
        const pushed = snap.candles[tf];
        const scale = snap.book.priceScale ?? 100;
        const px = pushed?.close ?? (snap.book.lastPrice != null ? snap.book.lastPrice / scale : null);
        const prev = lastBar.current;
        if (!prev || px == null || !Number.isFinite(px)) return;
        const time = pushed && pushed.time >= prev.time ? pushed.time : prev.time;
        const open = time === prev.time ? prev.open : (pushed?.open ?? px);
        const next: Candle = {
          time,
          open,
          high: Math.max(time === prev.time ? prev.high : open, px),
          low: Math.min(time === prev.time ? prev.low : open, px),
          close: px,
          volume: pushed && time === pushed.time ? pushed.volume : prev.volume,
        };
        if (next.time === prev.time && next.close === prev.close && next.high === prev.high && next.low === prev.low) return;
        lastBar.current = next;
        setLiveBar(next);
        handle.candle.update({ time: next.time as UTCTimestamp, open: next.open, high: next.high, low: next.low, close: next.close });
        if (
          studiesRef.current.vol &&
          volumesRef.current?.length !== barsRef.current.length &&
          next.volume > 0
        ) {
          handle.volume.update({
            time: next.time as UTCTimestamp,
            value: next.volume,
            color: next.close >= next.open ? "rgba(61,220,151,0.45)" : "rgba(255,93,108,0.4)",
          });
        }
        const box = window as Window & { __meridexTick?: { sentAt: number; recvAt: number; paintedAt: number; engineMs: number } };
        box.__meridexTick = { sentAt: snap.sentAt, recvAt: snap.recvAt, paintedAt: Date.now(), engineMs: snap.engineMs };
      });
    });
  }, [symbol, tf, ready]);

  function drawOverlay() {
    const canvas = layer.current;
    const handle = api.current;
    if (!canvas || !handle) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = "#F5D58A";
    ctx.fillStyle = "rgba(245,213,138,0.9)";
    ctx.font = "11px IBM Plex Mono, monospace";
    const xOf = (time: number) => handle.chart.timeScale().timeToCoordinate(time as UTCTimestamp);
    const yOf = (price: number) => handle.candle.priceToCoordinate(price);
    for (const item of drawings.current) {
      if (item.kind === "hline") {
        const y = yOf(item.a.price);
        if (y == null) continue;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
        ctx.fillText(formatPx(item.a.price, priceDecimals), 8, y - 4);
        continue;
      }
      const x1 = xOf(item.a.time);
      const y1 = yOf(item.a.price);
      const x2 = xOf(item.b.time);
      const y2 = yOf(item.b.price);
      if (x1 == null || y1 == null || x2 == null || y2 == null) continue;
      if (item.kind === "trend") {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        continue;
      }
      const levels = [0, 0.382, 0.5, 0.618, 1];
      const left = Math.min(x1, x2);
      const right = Math.max(x1, x2);
      for (const level of levels) {
        const price = item.a.price + (item.b.price - item.a.price) * level;
        const y = yOf(price);
        if (y == null) continue;
        ctx.globalAlpha = level === 0 || level === 1 ? 0.95 : 0.55;
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
        ctx.stroke();
        ctx.fillText(level.toFixed(3), right + 4, y - 2);
      }
      ctx.globalAlpha = 1;
    }
  }

  function onPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (drawMode === "none" || !api.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const time = api.current.chart.timeScale().coordinateToTime(x);
    const price = api.current.candle.coordinateToPrice(y);
    if (typeof time !== "number" || price == null) return;
    const point = { time, price };
    if (drawMode === "hline") {
      const span = bars.length ? bars[bars.length - 1].time - bars[0].time : 0;
      const next: Drawing = { id: `${time}`, kind: "hline", a: point, b: { time: time + span, price } };
      drawings.current = [...drawings.current, next];
    } else if (!pending.current) {
      pending.current = point;
      return;
    } else {
      const next: Drawing = { id: `${pending.current.time}-${time}`, kind: drawMode, a: pending.current, b: point };
      pending.current = null;
      drawings.current = [...drawings.current, next];
    }
    localStorage.setItem(`meridex.draw.${symbol}`, JSON.stringify(drawings.current));
    drawOverlay();
  }

  const osc = useMemo(() => {
    if (!studies.macd && !studies.rsi) return { macd: null, rsi: null };
    const closes = bars.map((bar) => bar.close);
    return {
      macd: studies.macd ? macd(closes) : null,
      rsi: studies.rsi ? rsi(closes) : null,
    };
  }, [bars, studies.macd, studies.rsi]);
  const macdView = osc.macd;
  const rsiView = osc.rsi;
  const selectedBar = hoveredTime === null
    ? liveBar ?? bars[bars.length - 1] ?? null
    : liveBar?.time === hoveredTime
      ? liveBar
      : barsRef.current.find((bar) => bar.time === hoveredTime) ?? null;
  const barChange = selectedBar && selectedBar.open !== 0
    ? (selectedBar.close - selectedBar.open) / selectedBar.open
    : null;

  return (
    <div className="chart-stack">
      <div className="chart-stage">
        {selectedBar ? (
          <div className="chart-readout" aria-label={`${symbol} ${tf} OHLC`}>
            <span><b>O</b> {formatPx(selectedBar.open, priceDecimals)}</span>
            <span><b>H</b> {formatPx(selectedBar.high, priceDecimals)}</span>
            <span><b>L</b> {formatPx(selectedBar.low, priceDecimals)}</span>
            <span><b>C</b> {formatPx(selectedBar.close, priceDecimals)}</span>
            <span className={barChange != null && barChange >= 0 ? "up" : "down"}>{formatPct(barChange)}</span>
          </div>
        ) : null}
        <div ref={host} className="chart-host" />
        <canvas ref={layer} className={`draw-layer ${drawMode === "none" ? "" : "on"}`} onPointerDown={onPointerDown} />
      </div>
      {macdView ? <Oscillator label="MACD" values={macdView.hist} line={macdView.line} /> : null}
      {rsiView ? <Oscillator label="RSI" values={rsiView} bounds={[30, 70]} /> : null}
    </div>
  );
}

export const CandleChart = memo(CandleChartInner);

function Oscillator({ label, values, line, bounds }: { label: string; values: (number | null)[]; line?: (number | null)[]; bounds?: [number, number] }) {
  const nums = values.filter((value): value is number => value != null);
  const extra = (line ?? []).filter((value): value is number => value != null);
  const pool = [...nums, ...extra];
  if (!pool.length) return null;
  const min = bounds ? 0 : Math.min(...pool);
  const max = bounds ? 100 : Math.max(...pool);
  const span = max - min || 1;
  const w = 320;
  const h = 56;
  const step = w / Math.max(1, values.length - 1);
  const yOf = (value: number) => h - ((value - min) / span) * (h - 8) - 4;
  let d = "";
  values.forEach((value, i) => {
    if (value == null) return;
    const cmd = d ? "L" : "M";
    d += `${cmd}${i * step},${yOf(value)} `;
  });
  let signal = "";
  (line ?? []).forEach((value, i) => {
    if (value == null) return;
    const cmd = signal ? "L" : "M";
    signal += `${cmd}${i * step},${yOf(value)} `;
  });
  return (
    <div className="osc">
      <span>{label}</span>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        {bounds?.map((level) => (
          <line key={level} x1="0" x2={w} y1={yOf(level)} y2={yOf(level)} />
        ))}
        <path d={d} />
        {signal ? <path d={signal} className="sig" /> : null}
      </svg>
    </div>
  );
}
