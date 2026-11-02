import assert from "node:assert/strict";
import { FUTURES, globalView, refreshGlobal, resetGlobalCache, setGlobalFetch, type GlobalResponse } from "./global.js";

function json(body: unknown, status = 200): GlobalResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => "" };
}

function route(match: (url: string) => unknown | null) {
  return async (url: string) => {
    const body = match(decodeURIComponent(url));
    if (body == null) return json(null, 404);
    return json(body);
  };
}

const geckoBtc = {
  id: "bitcoin",
  current_price: 80_000,
  high_24h: 81_000,
  low_24h: 79_000,
  total_volume: 10_000_000_000,
  price_change_percentage_24h: 1.5,
};

async function main() {
  resetGlobalCache();
  setGlobalFetch(route((url) => {
    if (url.includes("coins/markets")) return [geckoBtc];
    if (url.includes("GC=F")) {
      return { chart: { result: [{ meta: { regularMarketPrice: 4000, regularMarketDayHigh: 4100, regularMarketDayLow: 3900, chartPreviousClose: 3800, regularMarketVolume: 2 } }] } };
    }
    return null;
  }));
  await refreshGlobal(1_000);
  const btc = globalView("BTC/USD", 1_000);
  assert.equal(btc.source, "CoinGecko");
  assert.equal(btc.kind, "aggregate");
  assert.equal(btc.volumeUsd, 10_000_000_000);
  assert.equal(btc.volumeBase, 10_000_000_000 / 80_000);
  assert.equal(btc.high, 81_000);
  assert.equal(btc.change, 0.015);
  assert.equal(btc.delayed, false);

  const eur = globalView("EUR/USD", 1_000);
  assert.equal(eur.kind, "otc");
  assert.equal(eur.volumeUsd, null);
  assert.equal(eur.volumeBase, null);

  const zinc = globalView("ZINC/USD", 1_000);
  assert.equal(zinc.kind, "none");
  assert.equal(zinc.volumeUsd, null);

  const spec = FUTURES["XAU/USD"];
  const xau = globalView("XAU/USD", 1_000);
  assert.equal(xau.source, "Yahoo Finance");
  assert.equal(xau.volumeUsd, 2 * spec.quotedUnits * (4000 / spec.quoteDivisor));
  assert.equal(xau.volumeBase, 2 * spec.basePerContract);
  assert.equal(xau.high, 4100 / spec.displayDivisor);
  assert.equal(xau.change, (4000 - 3800) / 3800);

  resetGlobalCache();
  setGlobalFetch(route((url) => {
    if (url.includes("coins/markets")) return [{ id: "bitcoin", current_price: 80_000, high_24h: 81_000, low_24h: 79_000, total_volume: 0 }];
    if (url.includes("ticker/24hr")) return null;
    if (url.includes("okx.com")) {
      return { data: [{ instId: "BTC-USDT", last: "80000", open24h: "79000", high24h: "81000", low24h: "78000", vol24h: "12.5", volCcy24h: "1000000" }] };
    }
    return null;
  }));
  await refreshGlobal(2_000);
  const viaOkx = globalView("BTC/USD", 2_000);
  assert.equal(viaOkx.source, "OKX");
  assert.equal(viaOkx.kind, "exchange");
  assert.equal(viaOkx.volumeBase, 12.5);
  assert.equal(viaOkx.volumeUsd, 1_000_000);
  assert.notEqual(viaOkx.volumeUsd, 0);

  resetGlobalCache();
  setGlobalFetch(route((url) => {
    if (url.includes("GC=F")) {
      return { chart: { result: [{ meta: { regularMarketPrice: 4000, regularMarketDayHigh: 4100, regularMarketDayLow: 3900, regularMarketVolume: null } }] } };
    }
    return null;
  }));
  await refreshGlobal(3_000);
  const bare = globalView("XAU/USD", 3_000);
  assert.equal(bare.volumeUsd, null);
  assert.equal(bare.volumeBase, null);
  assert.equal(bare.high, 4100 / spec.displayDivisor);
  assert.equal(bare.source, "Yahoo Finance");

  setGlobalFetch(async () => null);
  await refreshGlobal(4_000);
  const kept = globalView("XAU/USD", 4_000 + 200_000);
  assert.equal(kept.volumeUsd, null);
  assert.equal(kept.high, bare.high);
  assert.equal(kept.delayed, true);

  setGlobalFetch(route((url) => (url.includes("coins/markets") ? [geckoBtc] : null)));
  await refreshGlobal(5_000);
  setGlobalFetch(async () => {
    throw new Error("down");
  });
  await refreshGlobal(6_000);
  const still = globalView("BTC/USD", 6_000 + 200_000);
  assert.equal(still.volumeUsd, 10_000_000_000);
  assert.equal(still.source, "CoinGecko");
  assert.equal(still.delayed, true);

  console.log("global feed vectors ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
