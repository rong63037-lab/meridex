import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.js";

export type Category = "metal" | "crypto" | "commodity" | "fx";
export type Access = "allow" | "pending" | "block";

export type Instrument = {
  symbol: string;
  nameZh: string;
  nameEn: string;
  category: Category;
  base: string;
  quote: string;
  tickSize: number;
  lotSize: number;
  minQty: number;
  qtyScale: number;
  priceScale: number;
  priceDecimals: number;
  qtyDecimals: number;
  quoteScale: number;
  bandBps: number;
  haltBps: number;
  refPrice: number;
  status: "trading" | "halted" | "pending";
  jurisdictions: string[];
  regulatoryTag: string;
  feed: string;
  networks: string[];
};

type Raw = {
  symbol: string;
  nameZh: string;
  nameEn: string;
  category: Category;
  base: string;
  quote: string;
  tickSize: number;
  lotSize: number;
  minQty: number;
  qtyScale: number;
  priceScale: number;
  priceDecimals: number;
  qtyDecimals: number;
  quoteScale: number;
  bandBps: number;
  haltBps: number;
  refPrice: number;
  status: Instrument["status"];
  jurisdictions: string[];
  regulatoryTag: string;
  feed: string;
  networks: string[];
};

let cache: Instrument[] | null = null;

export function loadCatalog(): Instrument[] {
  if (cache) return cache;
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "../../engine/instruments.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as Raw[];
  cache = raw.map((row) => ({ ...row }));
  return cache;
}

export function getInstrument(symbol: string): Instrument {
  const found = loadCatalog().find((row) => row.symbol === symbol);
  if (!found) throw new Error("UNKNOWN_SYMBOL");
  return found;
}

export function quoteNotional(qty: bigint, price: bigint, inst: Pick<Instrument, "qtyScale" | "priceScale" | "quoteScale">): bigint {
  const den = BigInt(inst.qtyScale) * BigInt(inst.priceScale);
  return (qty * price * BigInt(inst.quoteScale)) / den;
}

export async function ensureInstruments(pool: Db): Promise<void> {
  for (const row of loadCatalog()) {
    await pool.query(
      `INSERT INTO instruments (
         symbol, name_zh, name_en, category, base_asset, quote_asset, tick_size, lot_size, min_qty,
         qty_scale, price_scale, price_decimals, qty_decimals, quote_scale, band_bps, halt_bps,
         ref_price, status, jurisdictions, regulatory_tag, feed, networks
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       ON CONFLICT (symbol) DO UPDATE SET
         name_zh = EXCLUDED.name_zh, name_en = EXCLUDED.name_en, category = EXCLUDED.category,
         base_asset = EXCLUDED.base_asset, quote_asset = EXCLUDED.quote_asset,
         tick_size = EXCLUDED.tick_size, lot_size = EXCLUDED.lot_size, min_qty = EXCLUDED.min_qty,
         qty_scale = EXCLUDED.qty_scale, price_scale = EXCLUDED.price_scale,
         price_decimals = EXCLUDED.price_decimals, qty_decimals = EXCLUDED.qty_decimals,
         quote_scale = EXCLUDED.quote_scale, band_bps = EXCLUDED.band_bps, halt_bps = EXCLUDED.halt_bps,
         ref_price = EXCLUDED.ref_price, regulatory_tag = EXCLUDED.regulatory_tag,
         feed = EXCLUDED.feed, networks = EXCLUDED.networks, jurisdictions = EXCLUDED.jurisdictions,
         updated_at = now()`,
      [
        row.symbol, row.nameZh, row.nameEn, row.category, row.base, row.quote, row.tickSize, row.lotSize, row.minQty,
        row.qtyScale, row.priceScale, row.priceDecimals, row.qtyDecimals, row.quoteScale, row.bandBps, row.haltBps,
        row.refPrice, row.status, row.jurisdictions, row.regulatoryTag, row.feed, row.networks,
      ],
    );
  }
}

export async function categoryAccess(pool: Db, category: Category, country: string): Promise<Access> {
  const row = await pool.query(
    `SELECT access FROM category_access WHERE category = $1 AND country = $2`,
    [category, country],
  );
  return (row.rows[0]?.access as Access | undefined) ?? "pending";
}

export function formatPrice(units: number, inst: Instrument): string {
  return (units / inst.priceScale).toFixed(inst.priceDecimals);
}

export function formatQty(units: number, inst: Instrument): string {
  return (units / inst.qtyScale).toFixed(inst.qtyDecimals);
}
