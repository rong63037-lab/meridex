/**
 * Candle cache and websocket tick shape. Needs the gateway on 127.0.0.1:7108.
 */
import assert from "node:assert/strict";

const GW = "http://127.0.0.1:7108";

async function candles(query: string) {
  const started = performance.now();
  const res = await fetch(`${GW}/api/market/candles?${query}`);
  const data = await res.json();
  return { ms: performance.now() - started, status: res.status, cache: res.headers.get("cache-control") || "", hit: res.headers.get("x-candle-cache"), data };
}

async function main() {
  const cold = await candles("symbol=XAU/USD&tf=1m&limit=300");
  assert.equal(cold.status, 200);
  assert.ok(cold.data.candles.length > 0 && cold.data.candles.length <= 300, `count ${cold.data.candles.length}`);
  assert.match(cold.cache, /max-age=/);
  assert.equal(typeof cold.data.serverTs, "number");
  const warm = await candles("symbol=XAU/USD&tf=1m&limit=300");
  assert.equal(warm.hit, "hit");
  assert.ok(warm.ms < 150, `warm ${warm.ms.toFixed(1)}ms`);
  const first = cold.data.candles[0].time as number;
  const older = await candles(`symbol=XAU/USD&tf=1m&limit=50&before=${first}`);
  assert.equal(older.status, 200);
  assert.ok(older.data.candles.length > 0, "older page empty");
  assert.ok(older.data.candles.every((bar: { time: number }) => bar.time < first), "before cursor leaked");
  assert.match(older.cache, /max-age=60/);

  const ws = new WebSocket("ws://127.0.0.1:7108/ws?symbol=XAU/USD");
  const msg = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws timeout")), 8000);
    ws.onmessage = (ev) => {
      const body = JSON.parse(String(ev.data));
      if (body.type !== "book") return;
      clearTimeout(timer);
      resolve(body);
    };
    ws.onerror = () => reject(new Error("ws error"));
  });
  ws.close();
  const sentAt = Number(msg.sentAt);
  assert.ok(Number.isFinite(sentAt) && sentAt > 0, "sentAt");
  assert.ok(Number.isFinite(Number(msg.engineMs)) && Number(msg.engineMs) < 300, `engineMs ${msg.engineMs}`);
  assert.ok(Array.isArray(msg.chart) && (msg.chart as unknown[]).length === 0, "chart history still on the socket");
  assert.equal(typeof (msg.candles as { "1m"?: { close: number } })["1m"]?.close, "number");
  const bytes = JSON.stringify(msg).length;
  assert.ok(bytes < 12000, `payload ${bytes}`);
  const transit = Date.now() - sentAt;
  assert.ok(transit < 300, `tick transit ${transit}ms`);
  console.log(`chart-perf ok cold=${cold.ms.toFixed(0)}ms warm=${warm.ms.toFixed(0)}ms bytes=${bytes} engineMs=${msg.engineMs} transit=${transit}ms bars=${cold.data.candles.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});