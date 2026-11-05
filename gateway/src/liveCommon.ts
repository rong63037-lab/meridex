import type { PoolClient } from "pg";
import type { Db } from "./db.js";
import { withTx } from "./db.js";
import type { EngineClient } from "./engineClient.js";
import { getInstrument, quoteNotional, type Instrument } from "./instruments.js";
import { moveBuckets, walletAmount, type CustomerRef, type WalletBucket } from "./ledger.js";
import { requireFreshTotp } from "./pool.js";
import { externalMark, pickMark } from "./liquidity/mark.js";

export class LiveError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export const PRODUCTS = ["margin", "perp", "copy"] as const;
export type Product = (typeof PRODUCTS)[number];
export type BookProduct = "margin" | "perp";

export const LIVE_BOOK_EMAIL = "live-book@internal.meridex";
export const DEFAULT_NOTIONAL = 500_000_000n;
export const DEFAULT_LEVERAGE = 3;
export const FUNDING_BPS = 1;
export const INTEREST_BPS = 1;
export const FUNDING_MS = 8 * 60 * 60 * 1000;

const PERPS = [
  { symbol: "XAU-PERP", spot: "XAU/USD" },
  { symbol: "BTC-PERP", spot: "BTC/USD" },
  { symbol: "ETH-PERP", spot: "ETH/USD" },
] as const;

export function bucketFor(product: BookProduct): "margin" | "derivatives" {
  return product === "margin" ? "margin" : "derivatives";
}

export function nextFunding(from = Date.now()): Date {
  const step = Math.ceil(from / FUNDING_MS) * FUNDING_MS;
  return new Date(step === from ? from + FUNDING_MS : step);
}

export function spotOf(symbol: string): string {
  const perp = PERPS.find((item) => item.symbol === symbol);
  if (perp) return perp.spot;
  return symbol;
}

export function perpSymbols(): string[] {
  return PERPS.map((item) => item.symbol);
}

export function qtyStep(inst: Instrument): bigint {
  let den = 1n;
  for (let i = 0; i < inst.qtyDecimals; i++) den *= 10n;
  const scale = BigInt(inst.qtyScale);
  if (den > 0n && scale % den === 0n) {
    const step = scale / den;
    if (step > 0n) return step;
  }
  return 1n;
}

export function assertQty(inst: Instrument, qty: bigint) {
  if (qty <= 0n) throw new LiveError("VALIDATION");
  if (qty < BigInt(inst.minQty)) throw new LiveError("MIN_QTY");
  const step = qtyStep(inst);
  if (qty % step !== 0n) throw new LiveError("STEP");
}

export function assertTick(inst: Instrument, price: bigint) {
  if (price <= 0n) throw new LiveError("VALIDATION");
  const tick = BigInt(inst.tickSize);
  if (tick > 0n && price % tick !== 0n) throw new LiveError("TICK");
}

export function pnlOf(inst: Instrument, side: string, qty: bigint, entry: bigint, mark: bigint): bigint {
  const up = quoteNotional(qty, mark, inst) - quoteNotional(qty, entry, inst);
  return side === "buy" ? up : -up;
}

export function priceForNotional(qty: bigint, notional: bigint, inst: Instrument): bigint {
  if (qty <= 0n || notional <= 0n) return 0n;
  return (notional * BigInt(inst.qtyScale) * BigInt(inst.priceScale)) / (qty * BigInt(inst.quoteScale));
}

/** Cushion is the loss the position can take before maintenance. */
export function liqPrice(inst: Instrument, side: string, qty: bigint, entry: bigint, cushion: bigint): string | null {
  if (qty <= 0n) return null;
  const entryN = quoteNotional(qty, entry, inst);
  if (side === "buy") {
    const target = entryN - (cushion > 0n ? cushion : 0n);
    if (target <= 0n) return "0";
    return priceForNotional(qty, target, inst).toString();
  }
  const target = entryN + (cushion > 0n ? cushion : 0n);
  return priceForNotional(qty, target, inst).toString();
}

export function maintenance(notional: bigint, leverage: number): bigint {
  const lev = BigInt(Math.max(leverage, 1));
  return notional / (lev * 2n);
}

export type ProductRow = { enabled: boolean; maxNotional: bigint; maxLeverage: number };

export async function productRow(pool: Db | PoolClient, product: Product): Promise<ProductRow> {
  const row = await pool.query(
    `SELECT enabled, max_notional_uusd::text, max_leverage FROM live_products WHERE product = $1`,
    [product],
  );
  if (!row.rowCount) return { enabled: false, maxNotional: DEFAULT_NOTIONAL, maxLeverage: DEFAULT_LEVERAGE };
  return {
    enabled: Boolean(row.rows[0].enabled),
    maxNotional: BigInt(row.rows[0].max_notional_uusd as string),
    maxLeverage: Number(row.rows[0].max_leverage),
  };
}

export async function customerOf(pool: Db | PoolClient, userId: number): Promise<CustomerRef> {
  const row = await pool.query(
    `SELECT id, entity_id, jurisdiction, role, is_internal_test FROM users WHERE id = $1`,
    [userId],
  );
  const found = row.rows[0];
  if (!found?.entity_id) throw new LiveError("KYC_REQUIRED");
  if (found.role !== "customer") throw new LiveError("FORBIDDEN");
  if (found.is_internal_test) throw new LiveError("PLAY_ONLY");
  return { id: userId, entityId: found.entity_id as string, jurisdiction: (found.jurisdiction as string) || "SG" };
}

export async function assertVerified(pool: Db | PoolClient, userId: number, product: Product): Promise<CustomerRef> {
  const user = await customerOf(pool, userId);
  const kyc = await pool.query(`SELECT residence_country, status FROM kyc_profiles WHERE user_id = $1`, [userId]);
  const country = kyc.rows[0]?.residence_country as string | undefined;
  const status = kyc.rows[0]?.status as string | undefined;
  if (!country) throw new LiveError("KYC_REQUIRED");
  if (status !== "approved") throw new LiveError(status === "pending" ? "KYC_PENDING" : "KYC_REQUIRED");
  if ((product === "margin" || product === "perp") && country === "US") throw new LiveError("US_RETAIL_BLOCK");
  return user;
}

export async function bookUser(pool: Db | PoolClient): Promise<CustomerRef> {
  const row = await pool.query(
    `SELECT id, entity_id, jurisdiction FROM users WHERE email = $1 AND role = 'bot'`,
    [LIVE_BOOK_EMAIL],
  );
  if (!row.rowCount || !row.rows[0].entity_id) throw new LiveError("HOUSE_SHORT");
  return {
    id: Number(row.rows[0].id),
    entityId: row.rows[0].entity_id as string,
    jurisdiction: (row.rows[0].jurisdiction as string) || "SG",
  };
}

export async function markOf(engine: EngineClient, spot: string): Promise<{ mark: bigint; index: bigint; bid: bigint; ask: bigint }> {
  const book = await engine.book(spot);
  const bid = BigInt(book.bids[0]?.price ?? 0);
  const ask = BigInt(book.asks[0]?.price ?? 0);
  const index = BigInt(Math.round(book.reference_price || book.last_trade_price || 0));
  const bookMark = bid && ask ? (bid + ask) / 2n : index;
  const ext = externalMark(spot);
  const picked = pickMark(bookMark, ext?.px ?? null, ext?.maxDriftBps ?? 500);
  if (!picked.usedExternal) return { mark: bookMark, index: index || bookMark, bid, ask };
  return { mark: picked.px, index: picked.px, bid: picked.px, ask: picked.px };
}

export async function openNotional(pool: Db | PoolClient, product: Product): Promise<bigint> {
  if (product === "copy") {
    const row = await pool.query(
      `SELECT COALESCE(SUM(margin_uusd * leverage), 0)::text AS n
       FROM real_positions WHERE status = 'open' AND copy_follow_id IS NOT NULL`,
    );
    return BigInt((row.rows[0]?.n as string | undefined) ?? "0");
  }
  const row = await pool.query(
    `SELECT COALESCE(SUM(margin_uusd * leverage), 0)::text AS n
     FROM real_positions WHERE status = 'open' AND product = $1`,
    [product],
  );
  return BigInt((row.rows[0]?.n as string | undefined) ?? "0");
}

export async function assertCaps(
  pool: Db | PoolClient,
  product: Product,
  leverage: number,
  addNotional: bigint,
  reducing: boolean,
) {
  const spec = await productRow(pool, product);
  if (!reducing && !spec.enabled) throw new LiveError("LIVE_OFF");
  if (!reducing && (leverage < 1 || leverage > spec.maxLeverage)) throw new LiveError("CAP_LEVERAGE");
  if (!reducing) {
    const used = await openNotional(pool, product);
    if (used + addNotional > spec.maxNotional) throw new LiveError("CAP_NOTIONAL");
  }
  return spec;
}

export async function freeMargin(
  client: PoolClient,
  user: CustomerRef,
  product: BookProduct,
): Promise<{ bucket: bigint; locked: bigint; free: bigint }> {
  const bucketName = bucketFor(product);
  const bucket = await walletAmount(client, user, "USD", bucketName);
  const pos = await client.query(
    `SELECT COALESCE(SUM(margin_uusd), 0)::text AS n FROM real_positions
     WHERE user_id = $1 AND product = $2 AND status = 'open'`,
    [user.id, product],
  );
  const ord = await client.query(
    `SELECT COALESCE(SUM(reserved_margin_uusd), 0)::text AS n FROM real_orders
     WHERE user_id = $1 AND product = $2 AND status = 'open'`,
    [user.id, product],
  );
  const locked = BigInt(pos.rows[0].n as string) + BigInt(ord.rows[0].n as string);
  const free = bucket > locked ? bucket - locked : 0n;
  return { bucket, locked, free };
}

export async function payHouse(
  client: PoolClient,
  user: CustomerRef,
  book: CustomerRef,
  bucket: WalletBucket,
  amount: bigint,
  kind: string,
  ref: string,
): Promise<void> {
  if (amount <= 0n) return;
  await moveBuckets(client, user, bucket, book, "available", "USD", amount, kind, ref);
}

/** Pay the customer from the house. Shortfall is recorded as PnL owed and is not minted. */
export async function payCustomer(
  client: PoolClient,
  book: CustomerRef,
  user: CustomerRef,
  bucket: WalletBucket,
  amount: bigint,
  product: string,
  ref: string,
): Promise<{ paid: bigint; owed: bigint }> {
  if (amount <= 0n) return { paid: 0n, owed: 0n };
  const have = await walletAmount(client, book, "USD", "available");
  const paid = have < amount ? have : amount;
  if (paid > 0n) await moveBuckets(client, book, "available", user, bucket, "USD", paid, "live_profit", ref);
  const owed = amount - paid;
  if (owed > 0n) {
    await client.query(
      `INSERT INTO live_pnl_owed (user_id, product, amount_uusd, ref) VALUES ($1,$2,$3,$4)`,
      [user.id, product, owed.toString(), ref],
    );
  }
  return { paid, owed };
}

export async function transferWallet(
  pool: Db,
  userId: number,
  from: "spot" | "margin" | "derivatives",
  to: "spot" | "margin" | "derivatives",
  amount: bigint,
) {
  if (from === to || amount <= 0n) throw new LiveError("VALIDATION");
  const gate: Product = from === "margin" || to === "margin" ? "margin" : "copy";
  const user = await assertVerified(pool, userId, gate);
  const destProduct: Product | null = to === "margin" ? "margin" : to === "derivatives" ? "perp" : null;
  if (destProduct) {
    const spec = await productRow(pool, destProduct);
    const copyOn = destProduct === "perp" ? (await productRow(pool, "copy")).enabled : false;
    if (!spec.enabled && !copyOn) throw new LiveError("LIVE_OFF");
  }
  const fromBucket: WalletBucket = from === "spot" ? "available" : from;
  const toBucket: WalletBucket = to === "spot" ? "available" : to;
  await withTx(pool, async (client) => {
    const have = await walletAmount(client, user, "USD", fromBucket);
    if (from !== "spot") {
      const product: BookProduct = from === "margin" ? "margin" : "perp";
      const { free } = await freeMargin(client, user, product);
      if (amount > free) throw new LiveError("INSUFFICIENT_FUNDS");
    } else if (have < amount) throw new LiveError("INSUFFICIENT_FUNDS");
    await moveBuckets(client, user, fromBucket, user, toBucket, "USD", amount, "live_transfer", `${from}->${to}`);
  });
  return walletView(pool, userId);
}

export async function walletView(pool: Db | PoolClient, userId: number) {
  const row = await pool.query(
    `SELECT a.bucket, b.amount::text AS n
     FROM accounts a JOIN balances b ON b.account_id = a.id
     WHERE a.customer_id = $1 AND a.asset = 'USD' AND a.bucket IN ('available','margin','derivatives')`,
    [userId],
  );
  const found: Record<string, string> = { available: "0", margin: "0", derivatives: "0" };
  for (const item of row.rows) found[item.bucket as string] = item.n as string;
  return { spotUusd: found.available, marginUusd: found.margin, derivativesUusd: found.derivatives };
}

export async function listProducts(pool: Db) {
  const rows = await pool.query(
    `SELECT product, enabled, max_notional_uusd::text, max_leverage, updated_at
     FROM live_products ORDER BY product`,
  );
  const audit = await pool.query(
    `SELECT id, product, actor_email, previous, next, created_at
     FROM live_product_audit ORDER BY id DESC LIMIT 12`,
  );
  return {
    products: rows.rows.map((row) => ({
      product: row.product as string,
      enabled: Boolean(row.enabled),
      maxNotionalUusd: row.max_notional_uusd as string,
      maxLeverage: Number(row.max_leverage),
      updatedAt: row.updated_at,
    })),
    audit: audit.rows,
  };
}

export async function setProduct(
  pool: Db,
  actor: { id: number; email: string },
  input: { product: Product; enabled: boolean; maxNotional: bigint; maxLeverage: number; totp?: string },
) {
  if (!PRODUCTS.includes(input.product)) throw new LiveError("VALIDATION");
  if (input.maxLeverage < 2 || input.maxLeverage > 10) throw new LiveError("VALIDATION");
  if (input.maxNotional < 1_000_000n || input.maxNotional > 1_000_000_000_000n) throw new LiveError("VALIDATION");
  await requireFreshTotp(pool, actor.id, input.totp);
  const owner = await pool.query(`SELECT address_pool_owner FROM users WHERE id = $1`, [actor.id]);
  if (!owner.rows[0]?.address_pool_owner) throw new LiveError("FORBIDDEN");
  const previous = await productRow(pool, input.product);
  const prevJson = {
    enabled: previous.enabled,
    maxNotionalUusd: previous.maxNotional.toString(),
    maxLeverage: previous.maxLeverage,
  };
  const nextJson = {
    enabled: input.enabled,
    maxNotionalUusd: input.maxNotional.toString(),
    maxLeverage: input.maxLeverage,
  };
  await pool.query(
    `INSERT INTO live_products (product, enabled, max_notional_uusd, max_leverage, updated_at)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (product) DO UPDATE
       SET enabled = EXCLUDED.enabled, max_notional_uusd = EXCLUDED.max_notional_uusd,
           max_leverage = EXCLUDED.max_leverage, updated_at = now()`,
    [input.product, input.enabled, input.maxNotional.toString(), input.maxLeverage],
  );
  await pool.query(
    `INSERT INTO live_product_audit (product, actor_user_id, actor_email, previous, next)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)`,
    [input.product, actor.id, actor.email, JSON.stringify(prevJson), JSON.stringify(nextJson)],
  );
  return listProducts(pool);
}

export async function houseExposure(pool: Db, engine: EngineClient) {
  const products = await listProducts(pool);
  const open = await pool.query(
    `SELECT product, symbol, side, qty::text, entry_px::text, margin_uusd::text, leverage, copy_follow_id
     FROM real_positions WHERE status = 'open'`,
  );
  const nets = new Map<string, { symbol: string; customer: bigint }>();
  let customerUpnl = 0n;
  const byProduct: Record<string, bigint> = { margin: 0n, perp: 0n, copy: 0n };
  for (const row of open.rows) {
    const symbol = row.symbol as string;
    const spot = spotOf(symbol);
    let inst: Instrument;
    try {
      inst = getInstrument(spot);
    } catch {
      continue;
    }
    const qty = BigInt(row.qty as string);
    const entry = BigInt(row.entry_px as string);
    const signed = row.side === "buy" ? qty : -qty;
    const asset = inst.base;
    const prev = nets.get(asset) ?? { symbol: spot, customer: 0n };
    prev.customer += signed;
    nets.set(asset, prev);
    const notion = BigInt(row.margin_uusd as string) * BigInt(row.leverage as number);
    byProduct[row.product as string] = (byProduct[row.product as string] ?? 0n) + notion;
    if (row.copy_follow_id) byProduct.copy += notion;
    try {
      const { mark } = await markOf(engine, spot);
      if (mark > 0n) customerUpnl += pnlOf(inst, row.side as string, qty, entry, mark);
    } catch {
      /* mark unavailable: exposure still shows quantity */
    }
  }
  const owed = await pool.query(`SELECT COALESCE(SUM(amount_uusd),0)::text AS n FROM live_pnl_owed`);
  const borrowed = await pool.query(
    `SELECT COALESCE(SUM(margin_uusd),0)::text AS n FROM real_positions WHERE status = 'open' AND product = 'margin'`,
  );
  return {
    products: products.products.map((item) => ({
      ...item,
      openNotionalUusd: (byProduct[item.product] ?? 0n).toString(),
    })),
    nets: [...nets.entries()].map(([asset, row]) => ({
      asset,
      symbol: row.symbol,
      customerQty: row.customer.toString(),
      houseQty: (-row.customer).toString(),
    })),
    unrealizedHouseUusd: (-customerUpnl).toString(),
    pnlOwedUusd: (owed.rows[0]?.n as string) ?? "0",
    marginLockedUusd: (borrowed.rows[0]?.n as string) ?? "0",
  };
}

export function instrumentFor(product: BookProduct, symbol: string): Instrument {
  if (product === "perp") {
    const spec = PERPS.find((item) => item.symbol === symbol);
    if (!spec) throw new LiveError("UNKNOWN_SYMBOL");
    return getInstrument(spec.spot);
  }
  if (symbol.endsWith("-PERP")) throw new LiveError("UNKNOWN_SYMBOL");
  try {
    const inst = getInstrument(symbol);
    if (inst.quote !== "USD" || inst.status === "halted") throw new LiveError("MARKET_HALTED");
    return inst;
  } catch (err) {
    if (err instanceof LiveError) throw err;
    throw new LiveError("UNKNOWN_SYMBOL");
  }
}
