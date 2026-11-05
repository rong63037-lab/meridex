import type pg from "pg";
import { noteCandle } from "./candles.js";
import { feeOf, houseBot, tierBps } from "./fees.js";

export class LedgerError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

type Client = pg.PoolClient;
type Asset = string;
type Side = "debit" | "credit";

type Account = { id: string; accountType: "asset" | "liability" };

const cache = new Map<string, Account>();

export type CustomerRef = {
  id: number;
  entityId: string;
  jurisdiction: string;
};

type Leg = {
  account: Account;
  side: Side;
  amount: bigint;
  asset: Asset;
  jurisdiction: string;
};

export async function ensureCustomer(client: Client, user: CustomerRef): Promise<void> {
  for (const asset of ["USD", "XAU"] as const) {
    for (const bucket of ["available", "reserved"] as const) {
      await ensureAccount(client, {
        entityId: user.entityId,
        code: `customer:${user.id}:${asset}:${bucket}`,
        accountType: "liability",
        asset,
        bucket,
        customerId: user.id,
        jurisdiction: user.jurisdiction,
      });
    }
  }
}

async function ensureAccount(
  client: Client,
  spec: {
    entityId: string;
    code: string;
    accountType: "asset" | "liability";
    asset: Asset;
    bucket: string;
    customerId: number | null;
    jurisdiction: string;
  },
): Promise<Account> {
  const key = `${spec.entityId}|${spec.code}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const row = await client.query(
    `INSERT INTO accounts (entity_id, code, account_type, asset, bucket, customer_id, jurisdiction)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (entity_id, code) DO UPDATE SET code = EXCLUDED.code
     RETURNING id, account_type`,
    [
      spec.entityId,
      spec.code,
      spec.accountType,
      spec.asset,
      spec.bucket,
      spec.customerId,
      spec.jurisdiction,
    ],
  );
  await client.query(
    `INSERT INTO balances (account_id, amount) VALUES ($1, 0) ON CONFLICT (account_id) DO NOTHING`,
    [row.rows[0].id],
  );
  const account = { id: String(row.rows[0].id), accountType: row.rows[0].account_type as Account["accountType"] };
  cache.set(key, account);
  return account;
}

async function house(client: Client, entityId: string, asset: Asset): Promise<Account> {
  const code = asset === "USD" ? "bank:USD" : `vault:${asset}`;
  const bucket = asset === "USD" ? "bank" : "vault";
  const jurisdiction = entityId === "SG-OPCO" ? "SG" : "MY";
  return ensureAccount(client, {
    entityId,
    code,
    accountType: "asset",
    asset,
    bucket,
    customerId: null,
    jurisdiction,
  });
}

export type WalletBucket = "available" | "reserved" | "withdraw_hold" | "margin" | "derivatives";

async function customerBucket(
  client: Client,
  user: CustomerRef,
  asset: Asset,
  bucket: WalletBucket,
): Promise<Account> {
  return ensureAccount(client, {
    entityId: user.entityId,
    code: `customer:${user.id}:${asset}:${bucket}`,
    accountType: "liability",
    asset,
    bucket,
    customerId: user.id,
    jurisdiction: user.jurisdiction,
  });
}

async function intercompany(
  client: Client,
  entityId: string,
  other: string,
  asset: Asset,
  direction: "due_to" | "due_from",
): Promise<Account> {
  return ensureAccount(client, {
    entityId,
    code: `intercompany:${other}:${asset}:${direction}`,
    accountType: direction === "due_from" ? "asset" : "liability",
    asset,
    bucket: direction,
    customerId: null,
    jurisdiction: entityId === "SG-OPCO" ? "SG" : "MY",
  });
}

async function postEntry(
  client: Client,
  entry: { transferId: string; entityId: string; kind: string; ref: string; actorUserId: number | null; legs: Leg[] },
): Promise<void> {
  const totals = new Map<Asset, { d: bigint; c: bigint }>();
  for (const leg of entry.legs) {
    if (leg.amount <= 0n) throw new LedgerError("NON_POSITIVE_POSTING");
    const t = totals.get(leg.asset) ?? { d: 0n, c: 0n };
    if (leg.side === "debit") t.d += leg.amount;
    else t.c += leg.amount;
    totals.set(leg.asset, t);
  }
  for (const [asset, t] of totals) {
    if (t.d !== t.c) throw new LedgerError(`UNBALANCED_${asset}`);
  }
  const inserted = await client.query(
    `INSERT INTO journal_entries (transfer_id, entity_id, kind, ref, actor_user_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [entry.transferId, entry.entityId, entry.kind, entry.ref, entry.actorUserId],
  );
  const entryId = inserted.rows[0].id;
  for (const leg of entry.legs) {
    const increase =
      (leg.account.accountType === "asset" && leg.side === "debit") ||
      (leg.account.accountType === "liability" && leg.side === "credit");
    const amt = leg.amount.toString();
    const updated = increase
      ? await client.query(`UPDATE balances SET amount = amount + $2::bigint WHERE account_id = $1`, [
          leg.account.id,
          amt,
        ])
      : await client.query(
          `UPDATE balances SET amount = amount - $2::bigint WHERE account_id = $1 AND amount >= $2::bigint`,
          [leg.account.id, amt],
        );
    if (updated.rowCount !== 1) throw new LedgerError("INSUFFICIENT_BALANCE");
    await client.query(
      `INSERT INTO postings (entry_id, account_id, side, amount, asset, entity_id, jurisdiction)
       VALUES ($1,$2,$3,$4::bigint,$5,$6,$7)`,
      [entryId, leg.account.id, leg.side, amt, leg.asset, entry.entityId, leg.jurisdiction],
    );
  }
}

async function recordActivity(
  client: Client,
  userId: number,
  kind: string,
  asset: Asset,
  amount: bigint,
  detail: string,
): Promise<void> {
  await client.query(
    `INSERT INTO activity (user_id, kind, asset, amount, detail) VALUES ($1,$2,$3,$4::bigint,$5)`,
    [userId, kind, asset, amount.toString(), detail],
  );
}

/** Move funds between two customer wallets of the same entity. Both legs stay liabilities, so the trial balance and conservation hold. */
export async function moveBuckets(
  client: Client,
  from: CustomerRef,
  fromBucket: WalletBucket,
  to: CustomerRef,
  toBucket: WalletBucket,
  asset: Asset,
  amount: bigint,
  kind: string,
  ref: string,
): Promise<void> {
  if (amount <= 0n) return;
  if (from.entityId !== to.entityId) throw new LedgerError("VALIDATION");
  await ensureCustomer(client, from);
  await ensureCustomer(client, to);
  const src = await customerBucket(client, from, asset, fromBucket);
  const dst = await customerBucket(client, to, asset, toBucket);
  await postEntry(client, {
    transferId: crypto.randomUUID(),
    entityId: from.entityId,
    kind,
    ref,
    actorUserId: from.id,
    legs: [
      { account: src, side: "debit", amount, asset, jurisdiction: from.jurisdiction },
      { account: dst, side: "credit", amount, asset, jurisdiction: to.jurisdiction },
    ],
  });
  await recordActivity(client, from.id, kind, asset, amount, ref);
  if (to.id !== from.id) await recordActivity(client, to.id, kind, asset, amount, ref);
}

export async function walletAmount(
  client: Client,
  user: CustomerRef,
  asset: Asset,
  bucket: WalletBucket,
): Promise<bigint> {
  await ensureCustomer(client, user);
  const account = await customerBucket(client, user, asset, bucket);
  const row = await client.query(`SELECT amount::text FROM balances WHERE account_id = $1 FOR UPDATE`, [account.id]);
  return BigInt((row.rows[0]?.amount as string | undefined) ?? "0");
}

/** Move available funds between two customers of the same entity. Both legs stay in customer buckets, so conservation holds. */
export async function moveAvailable(
  client: Client,
  from: CustomerRef,
  to: CustomerRef,
  asset: Asset,
  amount: bigint,
  kind: string,
  ref: string,
): Promise<void> {
  if (amount <= 0n) return;
  if (from.entityId !== to.entityId) throw new LedgerError("VALIDATION");
  await ensureCustomer(client, from);
  await ensureCustomer(client, to);
  const src = await customerBucket(client, from, asset, "available");
  const dst = await customerBucket(client, to, asset, "available");
  await postEntry(client, {
    transferId: crypto.randomUUID(),
    entityId: from.entityId,
    kind,
    ref,
    actorUserId: from.id,
    legs: [
      { account: src, side: "debit", amount, asset, jurisdiction: from.jurisdiction },
      { account: dst, side: "credit", amount, asset, jurisdiction: to.jurisdiction },
    ],
  });
  await recordActivity(client, from.id, kind, asset, amount, ref);
}

/**
 * A-book spot fill. The customer trades against the house omnibus for the
 * filled quantity only. Nothing is written to `trades`, and the reserved
 * bucket is not used. Debits equal credits on each asset, so conservation holds.
 * Call this only after the provider has filled. A zero fill must not call it.
 */
export async function postLpSpot(
  client: Client,
  user: CustomerRef,
  fill: {
    orderId: string;
    symbol: string;
    base: string;
    quote: string;
    side: "buy" | "sell";
    orderType: string;
    qty: bigint;
    price: bigint;
    notional: bigint;
    qtyScale: bigint;
    priceScale: bigint;
    quoteScale: bigint;
  },
): Promise<void> {
  if (fill.qty <= 0n || fill.notional <= 0n) throw new LedgerError("VALIDATION");
  if (fill.quote !== "USD") throw new LedgerError("LP_QUOTE");
  await ensureCustomer(client, user);
  const quoteAvail = await customerBucket(client, user, fill.quote, "available");
  const baseAvail = await customerBucket(client, user, fill.base, "available");
  const bank = await house(client, user.entityId, fill.quote);
  const vault = await house(client, user.entityId, fill.base);
  const legs: Leg[] =
    fill.side === "buy"
      ? [
          { account: quoteAvail, side: "debit", amount: fill.notional, asset: fill.quote, jurisdiction: user.jurisdiction },
          { account: bank, side: "credit", amount: fill.notional, asset: fill.quote, jurisdiction: user.jurisdiction },
          { account: vault, side: "debit", amount: fill.qty, asset: fill.base, jurisdiction: user.jurisdiction },
          { account: baseAvail, side: "credit", amount: fill.qty, asset: fill.base, jurisdiction: user.jurisdiction },
        ]
      : [
          { account: baseAvail, side: "debit", amount: fill.qty, asset: fill.base, jurisdiction: user.jurisdiction },
          { account: vault, side: "credit", amount: fill.qty, asset: fill.base, jurisdiction: user.jurisdiction },
          { account: bank, side: "debit", amount: fill.notional, asset: fill.quote, jurisdiction: user.jurisdiction },
          { account: quoteAvail, side: "credit", amount: fill.notional, asset: fill.quote, jurisdiction: user.jurisdiction },
        ];
  await postEntry(client, {
    transferId: crypto.randomUUID(),
    entityId: user.entityId,
    kind: "lp_spot",
    ref: fill.orderId,
    actorUserId: user.id,
    legs,
  });
  await client.query(
    `INSERT INTO order_holds (
       engine_order_id, user_id, entity_id, jurisdiction, side, order_type, price_cents,
       qty_mg, leaves_mg, filled_mg, reserved_uusd, reserved_mg, status,
       symbol, base_asset, quote_asset, qty_scale, price_scale, quote_scale
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$8,0,0,'filled',$9,$10,$11,$12,$13,$14)`,
    [
      fill.orderId,
      user.id,
      user.entityId,
      user.jurisdiction,
      fill.side,
      fill.orderType,
      fill.price.toString(),
      fill.qty.toString(),
      fill.symbol,
      fill.base,
      fill.quote,
      fill.qtyScale.toString(),
      fill.priceScale.toString(),
      fill.quoteScale.toString(),
    ],
  );
  await client.query(
    `INSERT INTO user_orders (
       engine_order_id, user_id, side, order_type, price_cents, qty_mg, leaves_mg, filled_mg,
       filled_notional_uusd, status, symbol, base_asset, quote_asset
     ) VALUES ($1,$2,$3,$4,$5,$6,0,$6,$7,'filled',$8,$9,$10)`,
    [
      fill.orderId,
      user.id,
      fill.side,
      fill.orderType,
      fill.price.toString(),
      fill.qty.toString(),
      fill.notional.toString(),
      fill.symbol,
      fill.base,
      fill.quote,
    ],
  );
  await recordActivity(client, user.id, "lp_spot", fill.side === "buy" ? fill.base : fill.quote, fill.side === "buy" ? fill.qty : fill.notional, fill.orderId);
}

export async function deposit(
  client: Client,
  user: CustomerRef,
  asset: Asset,
  amount: bigint,
  meta?: { ref?: string; actorUserId?: number },
): Promise<string> {
  if (amount <= 0n) throw new LedgerError("VALIDATION");
  await ensureCustomer(client, user);
  const transferId = crypto.randomUUID();
  const ref = meta?.ref ?? `user:${user.id}`;
  const actorUserId = meta?.actorUserId ?? user.id;
  if (asset === "USD") {
    const bank = await house(client, user.entityId, "USD");
    const avail = await customerBucket(client, user, "USD", "available");
    await postEntry(client, {
      transferId,
      entityId: user.entityId,
      kind: "deposit_usd",
      ref,
      actorUserId,
      legs: [
        { account: bank, side: "debit", amount, asset: "USD", jurisdiction: user.jurisdiction },
        { account: avail, side: "credit", amount, asset: "USD", jurisdiction: user.jurisdiction },
      ],
    });
  } else {
    const vault = await house(client, user.entityId, asset);
    const avail = await customerBucket(client, user, asset, "available");
    await postEntry(client, {
      transferId,
      entityId: user.entityId,
      kind: "vault_in",
      ref,
      actorUserId,
      legs: [
        { account: vault, side: "debit", amount, asset, jurisdiction: user.jurisdiction },
        { account: avail, side: "credit", amount, asset, jurisdiction: user.jurisdiction },
      ],
    });
  }
  await recordActivity(client, user.id, asset === "USD" ? "deposit_usd" : "vault_in", asset, amount, meta?.ref ?? "");
  return transferId;
}

export async function withdraw(
  client: Client,
  user: CustomerRef,
  asset: Asset,
  amount: bigint,
): Promise<void> {
  if (amount <= 0n) throw new LedgerError("VALIDATION");
  await ensureCustomer(client, user);
  const transferId = crypto.randomUUID();
  if (asset === "USD") {
    const bank = await house(client, user.entityId, "USD");
    const avail = await customerBucket(client, user, "USD", "available");
    await postEntry(client, {
      transferId,
      entityId: user.entityId,
      kind: "withdraw_usd",
      ref: `user:${user.id}`,
      actorUserId: user.id,
      legs: [
        { account: avail, side: "debit", amount, asset: "USD", jurisdiction: user.jurisdiction },
        { account: bank, side: "credit", amount, asset: "USD", jurisdiction: user.jurisdiction },
      ],
    });
  } else {
    const vault = await house(client, user.entityId, asset);
    const avail = await customerBucket(client, user, asset, "available");
    await postEntry(client, {
      transferId,
      entityId: user.entityId,
      kind: "vault_out",
      ref: `user:${user.id}`,
      actorUserId: user.id,
      legs: [
        { account: avail, side: "debit", amount, asset, jurisdiction: user.jurisdiction },
        { account: vault, side: "credit", amount, asset, jurisdiction: user.jurisdiction },
      ],
    });
  }
  await recordActivity(client, user.id, asset === "USD" ? "withdraw_usd" : "vault_out", asset, amount, "");
}

/** Move available into withdraw_hold. Order reserves stay in the reserved bucket. */
export async function holdFunds(
  client: Client,
  user: CustomerRef,
  asset: Asset,
  amount: bigint,
  ref: string,
): Promise<string> {
  if (amount <= 0n) throw new LedgerError("VALIDATION");
  await ensureCustomer(client, user);
  const transferId = crypto.randomUUID();
  const avail = await customerBucket(client, user, asset, "available");
  const held = await customerBucket(client, user, asset, "withdraw_hold");
  await postEntry(client, {
    transferId,
    entityId: user.entityId,
    kind: "withdraw_hold",
    ref,
    actorUserId: user.id,
    legs: [
      { account: avail, side: "debit", amount, asset, jurisdiction: user.jurisdiction },
      { account: held, side: "credit", amount, asset, jurisdiction: user.jurisdiction },
    ],
  });
  await recordActivity(client, user.id, "withdraw_hold", asset, amount, ref);
  return transferId;
}

/** Reject path: withdraw_hold back to available. */
export async function releaseHold(
  client: Client,
  user: CustomerRef,
  asset: Asset,
  amount: bigint,
  ref: string,
  actorUserId: number,
): Promise<string> {
  if (amount <= 0n) throw new LedgerError("VALIDATION");
  await ensureCustomer(client, user);
  const transferId = crypto.randomUUID();
  const avail = await customerBucket(client, user, asset, "available");
  const held = await customerBucket(client, user, asset, "withdraw_hold");
  await postEntry(client, {
    transferId,
    entityId: user.entityId,
    kind: "withdraw_release",
    ref,
    actorUserId,
    legs: [
      { account: held, side: "debit", amount, asset, jurisdiction: user.jurisdiction },
      { account: avail, side: "credit", amount, asset, jurisdiction: user.jurisdiction },
    ],
  });
  await recordActivity(client, user.id, "withdraw_release", asset, amount, ref);
  return transferId;
}

/** Approve path: withdraw_hold out to the bank or vault. The fee is already inside amount. */
export async function settleHold(
  client: Client,
  user: CustomerRef,
  asset: Asset,
  amount: bigint,
  ref: string,
  actorUserId: number,
): Promise<string> {
  if (amount <= 0n) throw new LedgerError("VALIDATION");
  await ensureCustomer(client, user);
  const transferId = crypto.randomUUID();
  const houseAcct = await house(client, user.entityId, asset);
  const held = await customerBucket(client, user, asset, "withdraw_hold");
  await postEntry(client, {
    transferId,
    entityId: user.entityId,
    kind: asset === "USD" ? "withdraw_usd" : "vault_out",
    ref,
    actorUserId,
    legs: [
      { account: held, side: "debit", amount, asset, jurisdiction: user.jurisdiction },
      { account: houseAcct, side: "credit", amount, asset, jurisdiction: user.jurisdiction },
    ],
  });
  await recordActivity(client, user.id, asset === "USD" ? "withdraw_usd" : "vault_out", asset, amount, ref);
  return transferId;
}

/** Reverse a deposit: customer available down, house cash or vault up. Fails closed when available is short. */
export async function depositReversal(
  client: Client,
  user: CustomerRef,
  asset: Asset,
  amount: bigint,
  ref: string,
  actorUserId: number,
): Promise<string> {
  if (amount <= 0n) throw new LedgerError("VALIDATION");
  await ensureCustomer(client, user);
  const transferId = crypto.randomUUID();
  const houseAcct = await house(client, user.entityId, asset);
  const avail = await customerBucket(client, user, asset, "available");
  await postEntry(client, {
    transferId,
    entityId: user.entityId,
    kind: "deposit_reversal",
    ref,
    actorUserId,
    legs: [
      { account: avail, side: "debit", amount, asset, jurisdiction: user.jurisdiction },
      { account: houseAcct, side: "credit", amount, asset, jurisdiction: user.jurisdiction },
    ],
  });
  await recordActivity(client, user.id, "deposit_reversal", asset, amount, ref);
  return transferId;
}

export async function reserveOrder(
  client: Client,
  user: CustomerRef,
  order: {
    orderId: string;
    side: "buy" | "sell";
    orderType: string;
    priceCents: bigint | null;
    qtyMg: bigint;
    reserveUusd: bigint;
    reserveMg: bigint;
    symbol?: string;
    baseAsset?: string;
    quoteAsset?: string;
    qtyScale?: bigint;
    priceScale?: bigint;
    quoteScale?: bigint;
  },
): Promise<void> {
  await ensureCustomer(client, user);
  const symbol = order.symbol ?? "XAU/USD";
  const base = order.baseAsset ?? "XAU";
  const quote = order.quoteAsset ?? "USD";
  const qtyScale = order.qtyScale ?? 1000n;
  const priceScale = order.priceScale ?? 100n;
  const quoteScale = order.quoteScale ?? 1_000_000n;
  const transferId = crypto.randomUUID();
  if (order.side === "buy") {
    if (order.reserveUusd <= 0n) throw new LedgerError("VALIDATION");
    const avail = await customerBucket(client, user, quote, "available");
    const reserved = await customerBucket(client, user, quote, "reserved");
    await postEntry(client, {
      transferId,
      entityId: user.entityId,
      kind: "reserve_quote",
      ref: order.orderId,
      actorUserId: user.id,
      legs: [
        { account: avail, side: "debit", amount: order.reserveUusd, asset: quote, jurisdiction: user.jurisdiction },
        {
          account: reserved,
          side: "credit",
          amount: order.reserveUusd,
          asset: quote,
          jurisdiction: user.jurisdiction,
        },
      ],
    });
  } else {
    if (order.reserveMg <= 0n) throw new LedgerError("VALIDATION");
    const avail = await customerBucket(client, user, base, "available");
    const reserved = await customerBucket(client, user, base, "reserved");
    await postEntry(client, {
      transferId,
      entityId: user.entityId,
      kind: "reserve_base",
      ref: order.orderId,
      actorUserId: user.id,
      legs: [
        { account: avail, side: "debit", amount: order.reserveMg, asset: base, jurisdiction: user.jurisdiction },
        { account: reserved, side: "credit", amount: order.reserveMg, asset: base, jurisdiction: user.jurisdiction },
      ],
    });
  }
  await client.query(
    `INSERT INTO order_holds (
       engine_order_id, user_id, entity_id, jurisdiction, side, order_type, price_cents,
       qty_mg, leaves_mg, filled_mg, reserved_uusd, reserved_mg, status,
       symbol, base_asset, quote_asset, qty_scale, price_scale, quote_scale
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,0,$9,$10,'pending',$11,$12,$13,$14,$15,$16)`,
    [
      order.orderId,
      user.id,
      user.entityId,
      user.jurisdiction,
      order.side,
      order.orderType,
      order.priceCents?.toString() ?? null,
      order.qtyMg.toString(),
      order.reserveUusd.toString(),
      order.reserveMg.toString(),
      symbol,
      base,
      quote,
      qtyScale.toString(),
      priceScale.toString(),
      quoteScale.toString(),
    ],
  );
  await client.query(
    `INSERT INTO user_orders (
       engine_order_id, user_id, side, order_type, price_cents, qty_mg, leaves_mg, filled_mg, status,
       symbol, base_asset, quote_asset
     ) VALUES ($1,$2,$3,$4,$5,$6,$6,0,'pending',$7,$8,$9)`,
    [
      order.orderId,
      user.id,
      order.side,
      order.orderType,
      order.priceCents?.toString() ?? null,
      order.qtyMg.toString(),
      symbol,
      base,
      quote,
    ],
  );
}

async function releaseRemaining(client: Client, orderId: string): Promise<void> {
  const hold = await client.query(`SELECT * FROM order_holds WHERE engine_order_id = $1 FOR UPDATE`, [orderId]);
  if (!hold.rowCount) return;
  const row = hold.rows[0];
  const usd = BigInt(row.reserved_uusd);
  const mg = BigInt(row.reserved_mg);
  const quote = (row.quote_asset as string | undefined) ?? "USD";
  const base = (row.base_asset as string | undefined) ?? "XAU";
  const user: CustomerRef = { id: Number(row.user_id), entityId: row.entity_id, jurisdiction: row.jurisdiction };
  const transferId = crypto.randomUUID();
  if (usd > 0n) {
    const avail = await customerBucket(client, user, quote, "available");
    const reserved = await customerBucket(client, user, quote, "reserved");
    await postEntry(client, {
      transferId,
      entityId: user.entityId,
      kind: "release_quote",
      ref: orderId,
      actorUserId: user.id,
      legs: [
        { account: reserved, side: "debit", amount: usd, asset: quote, jurisdiction: user.jurisdiction },
        { account: avail, side: "credit", amount: usd, asset: quote, jurisdiction: user.jurisdiction },
      ],
    });
  }
  if (mg > 0n) {
    const transferIdGold = crypto.randomUUID();
    const avail = await customerBucket(client, user, base, "available");
    const reserved = await customerBucket(client, user, base, "reserved");
    await postEntry(client, {
      transferId: transferIdGold,
      entityId: user.entityId,
      kind: "release_base",
      ref: orderId,
      actorUserId: user.id,
      legs: [
        { account: reserved, side: "debit", amount: mg, asset: base, jurisdiction: user.jurisdiction },
        { account: avail, side: "credit", amount: mg, asset: base, jurisdiction: user.jurisdiction },
      ],
    });
  }
  await client.query(
    `UPDATE order_holds SET reserved_uusd = 0, reserved_mg = 0, updated_at = now() WHERE engine_order_id = $1`,
    [orderId],
  );
}

type HoldRow = {
  engine_order_id: string;
  user_id: string;
  entity_id: string;
  jurisdiction: string;
  side: "buy" | "sell";
  price_cents: string | null;
  leaves_mg: string;
  filled_mg: string;
  reserved_uusd: string;
  reserved_mg: string;
  status: string;
  symbol?: string;
  base_asset?: string;
  quote_asset?: string;
  qty_scale?: string;
  price_scale?: string;
  quote_scale?: string;
};

async function lockHold(client: Client, orderId: string): Promise<HoldRow> {
  const res = await client.query(`SELECT * FROM order_holds WHERE engine_order_id = $1 FOR UPDATE`, [orderId]);
  if (!res.rowCount) throw new LedgerError("HOLD_MISSING");
  return res.rows[0] as HoldRow;
}

/** Put a released hold back in funds so a book trade can settle after a missed ledger post. */
export async function coverHold(client: Client, orderId: string, quoteNeed: bigint, baseNeed: bigint): Promise<void> {
  const hold = await lockHold(client, orderId);
  const user: CustomerRef = { id: Number(hold.user_id), entityId: hold.entity_id, jurisdiction: hold.jurisdiction };
  const quote = hold.quote_asset ?? "USD";
  const base = hold.base_asset ?? "XAU";
  const quoteShort = quoteNeed - BigInt(hold.reserved_uusd);
  const baseShort = baseNeed - BigInt(hold.reserved_mg);
  if (quoteShort > 0n) {
    const avail = await customerBucket(client, user, quote, "available");
    const reserved = await customerBucket(client, user, quote, "reserved");
    await postEntry(client, {
      transferId: crypto.randomUUID(),
      entityId: user.entityId,
      kind: "reserve_quote",
      ref: orderId,
      actorUserId: user.id,
      legs: [
        { account: avail, side: "debit", amount: quoteShort, asset: quote, jurisdiction: user.jurisdiction },
        { account: reserved, side: "credit", amount: quoteShort, asset: quote, jurisdiction: user.jurisdiction },
      ],
    });
    await client.query(
      `UPDATE order_holds SET reserved_uusd = reserved_uusd + $2::bigint, updated_at = now() WHERE engine_order_id = $1`,
      [orderId, quoteShort.toString()],
    );
  }
  if (baseShort > 0n) {
    const avail = await customerBucket(client, user, base, "available");
    const reserved = await customerBucket(client, user, base, "reserved");
    await postEntry(client, {
      transferId: crypto.randomUUID(),
      entityId: user.entityId,
      kind: "reserve_base",
      ref: orderId,
      actorUserId: user.id,
      legs: [
        { account: avail, side: "debit", amount: baseShort, asset: base, jurisdiction: user.jurisdiction },
        { account: reserved, side: "credit", amount: baseShort, asset: base, jurisdiction: user.jurisdiction },
      ],
    });
    await client.query(
      `UPDATE order_holds SET reserved_mg = reserved_mg + $2::bigint, updated_at = now() WHERE engine_order_id = $1`,
      [orderId, baseShort.toString()],
    );
  }
}

export async function settleTrade(
  client: Client,
  trade: {
    tradeId: string;
    priceCents: bigint;
    qtyMg: bigint;
    buyerOrderId: string;
    sellerOrderId: string;
    takerOrderId: string;
    makerOrderId: string;
    takerSide: string;
  },
): Promise<void> {
  const buyerHold = await lockHold(client, trade.buyerOrderId);
  const sellerHold = await lockHold(client, trade.sellerOrderId);
  const symbol = buyerHold.symbol ?? "XAU/USD";
  const exists = await client.query(
    `SELECT 1 FROM trades WHERE symbol = $1 AND engine_trade_id = $2`,
    [symbol, trade.tradeId],
  );
  if (exists.rowCount) return;
  if (!buyerHold.price_cents) throw new LedgerError("MISSING_BUY_PRICE");
  const limit = BigInt(buyerHold.price_cents);
  const qtyScale = BigInt(buyerHold.qty_scale ?? "1000");
  const priceScale = BigInt(buyerHold.price_scale ?? "100");
  const quoteScale = BigInt(buyerHold.quote_scale ?? "1000000");
  const quote = buyerHold.quote_asset ?? "USD";
  const base = buyerHold.base_asset ?? "XAU";
  const notion = (qty: bigint, price: bigint) => (qty * price * quoteScale) / (qtyScale * priceScale);
  const slice = notion(trade.qtyMg, limit);
  const actual = notion(trade.qtyMg, trade.priceCents);
  if (slice < actual) throw new LedgerError("PRICE_ABOVE_RESERVE");
  if (BigInt(buyerHold.reserved_uusd) < slice) throw new LedgerError("BUYER_RESERVE_SHORT");
  if (BigInt(sellerHold.reserved_mg) < trade.qtyMg) throw new LedgerError("SELLER_RESERVE_SHORT");
  const improvement = slice - actual;
  const buyer: CustomerRef = {
    id: Number(buyerHold.user_id),
    entityId: buyerHold.entity_id,
    jurisdiction: buyerHold.jurisdiction,
  };
  const seller: CustomerRef = {
    id: Number(sellerHold.user_id),
    entityId: sellerHold.entity_id,
    jurisdiction: sellerHold.jurisdiction,
  };
  const transferId = crypto.randomUUID();
  const buyerUsdReserved = await customerBucket(client, buyer, quote, "reserved");
  const buyerUsdAvail = await customerBucket(client, buyer, quote, "available");
  const buyerXauAvail = await customerBucket(client, buyer, base, "available");
  const sellerUsdAvail = await customerBucket(client, seller, quote, "available");
  const sellerXauReserved = await customerBucket(client, seller, base, "reserved");

  if (buyer.entityId === seller.entityId) {
    const legs: Leg[] = [
      { account: buyerUsdReserved, side: "debit", amount: actual, asset: quote, jurisdiction: buyer.jurisdiction },
      { account: sellerUsdAvail, side: "credit", amount: actual, asset: quote, jurisdiction: seller.jurisdiction },
      { account: sellerXauReserved, side: "debit", amount: trade.qtyMg, asset: base, jurisdiction: seller.jurisdiction },
      { account: buyerXauAvail, side: "credit", amount: trade.qtyMg, asset: base, jurisdiction: buyer.jurisdiction },
    ];
    if (improvement > 0n) {
      legs.push(
        { account: buyerUsdReserved, side: "debit", amount: improvement, asset: quote, jurisdiction: buyer.jurisdiction },
        { account: buyerUsdAvail, side: "credit", amount: improvement, asset: quote, jurisdiction: buyer.jurisdiction },
      );
    }
    await postEntry(client, {
      transferId,
      entityId: buyer.entityId,
      kind: "trade_dvp",
      ref: trade.tradeId,
      actorUserId: null,
      legs,
    });
  } else {
    const buyerDueTo = await intercompany(client, buyer.entityId, seller.entityId, quote, "due_to");
    const buyerDueFromGold = await intercompany(client, buyer.entityId, seller.entityId, base, "due_from");
    const sellerDueFrom = await intercompany(client, seller.entityId, buyer.entityId, quote, "due_from");
    const sellerDueToGold = await intercompany(client, seller.entityId, buyer.entityId, base, "due_to");
    const buyerLegs: Leg[] = [
      { account: buyerUsdReserved, side: "debit", amount: actual, asset: quote, jurisdiction: buyer.jurisdiction },
      { account: buyerDueTo, side: "credit", amount: actual, asset: quote, jurisdiction: buyer.jurisdiction },
      { account: buyerDueFromGold, side: "debit", amount: trade.qtyMg, asset: base, jurisdiction: buyer.jurisdiction },
      { account: buyerXauAvail, side: "credit", amount: trade.qtyMg, asset: base, jurisdiction: buyer.jurisdiction },
    ];
    if (improvement > 0n) {
      buyerLegs.push(
        { account: buyerUsdReserved, side: "debit", amount: improvement, asset: quote, jurisdiction: buyer.jurisdiction },
        { account: buyerUsdAvail, side: "credit", amount: improvement, asset: quote, jurisdiction: buyer.jurisdiction },
      );
    }
    await postEntry(client, {
      transferId,
      entityId: buyer.entityId,
      kind: "trade_dvp",
      ref: trade.tradeId,
      actorUserId: null,
      legs: buyerLegs,
    });
    await postEntry(client, {
      transferId,
      entityId: seller.entityId,
      kind: "trade_dvp",
      ref: trade.tradeId,
      actorUserId: null,
      legs: [
        { account: sellerDueFrom, side: "debit", amount: actual, asset: quote, jurisdiction: seller.jurisdiction },
        { account: sellerUsdAvail, side: "credit", amount: actual, asset: quote, jurisdiction: seller.jurisdiction },
        { account: sellerXauReserved, side: "debit", amount: trade.qtyMg, asset: base, jurisdiction: seller.jurisdiction },
        { account: sellerDueToGold, side: "credit", amount: trade.qtyMg, asset: base, jurisdiction: seller.jurisdiction },
      ],
    });
  }

  let buyerFeeUusd = 0n;
  let sellerFeeUusd = 0n;
  const buyerBps = (await tierBps(client, buyer.id, "spot"))[trade.takerOrderId === trade.buyerOrderId ? "taker" : "maker"];
  const sellerBps = (await tierBps(client, seller.id, "spot"))[trade.takerOrderId === trade.sellerOrderId ? "taker" : "maker"];
  const buyerBaseFee = (trade.qtyMg * BigInt(buyerBps)) / 10_000n;
  const sellerQuoteFee = feeOf(actual, sellerBps);
  const house = await houseBot(client, "bot-mm@internal.meridex");
  if (house && buyerBaseFee > 0n && house.entityId === buyer.entityId) {
    const haveBase = await walletAmount(client, buyer, base, "available");
    if (haveBase >= buyerBaseFee) {
      await moveAvailable(client, buyer, house, base, buyerBaseFee, "trade_fee", trade.tradeId);
      buyerFeeUusd = feeOf(actual, buyerBps);
    }
  }
  if (house && sellerQuoteFee > 0n && house.entityId === seller.entityId) {
    const haveQuote = await walletAmount(client, seller, quote, "available");
    if (haveQuote >= sellerQuoteFee) {
      await moveAvailable(client, seller, house, quote, sellerQuoteFee, "trade_fee", trade.tradeId);
      sellerFeeUusd = sellerQuoteFee;
    }
  }

  await client.query(
    `UPDATE order_holds SET
       reserved_uusd = reserved_uusd - $2::bigint,
       filled_mg = filled_mg + $3::bigint,
       leaves_mg = leaves_mg - $3::bigint,
       updated_at = now()
     WHERE engine_order_id = $1`,
    [trade.buyerOrderId, slice.toString(), trade.qtyMg.toString()],
  );
  await client.query(
    `UPDATE order_holds SET
       reserved_mg = reserved_mg - $2::bigint,
       filled_mg = filled_mg + $2::bigint,
       leaves_mg = leaves_mg - $2::bigint,
       updated_at = now()
     WHERE engine_order_id = $1`,
    [trade.sellerOrderId, trade.qtyMg.toString()],
  );
  await client.query(
    `INSERT INTO trades (
       engine_trade_id, price_cents, qty_mg, notional_uusd, buyer_id, seller_id,
       buyer_entity, seller_entity, buyer_jurisdiction, seller_jurisdiction,
       taker_order_id, maker_order_id, taker_side, symbol, base_asset, quote_asset,
       buyer_fee_uusd, seller_fee_uusd
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      trade.tradeId,
      trade.priceCents.toString(),
      trade.qtyMg.toString(),
      actual.toString(),
      buyer.id,
      seller.id,
      buyer.entityId,
      seller.entityId,
      buyer.jurisdiction,
      seller.jurisdiction,
      trade.takerOrderId,
      trade.makerOrderId,
      trade.takerSide,
      buyerHold.symbol ?? "XAU/USD",
      base,
      quote,
      buyerFeeUusd.toString(),
      sellerFeeUusd.toString(),
    ],
  );
  await noteCandle(client, symbol, trade.priceCents, trade.qtyMg, actual);
  const detail = `${buyerHold.symbol ?? "XAU/USD"} ${trade.qtyMg.toString()} @ ${trade.priceCents.toString()}`;
  await recordActivity(client, buyer.id, "trade_buy", quote, actual, detail);
  await recordActivity(client, seller.id, "trade_sell", base, trade.qtyMg, detail);
  for (const orderId of [trade.buyerOrderId, trade.sellerOrderId]) {
    await client.query(
      `UPDATE user_orders SET
         filled_mg = filled_mg + $2::bigint,
         leaves_mg = leaves_mg - $2::bigint,
         filled_notional_uusd = filled_notional_uusd + $3::bigint,
         updated_at = now()
       WHERE engine_order_id = $1`,
      [orderId, trade.qtyMg.toString(), actual.toString()],
    );
  }
}

export async function finishOrder(
  client: Client,
  orderId: string,
  status: "rejected" | "open" | "filled" | "canceled",
  rejectReason: string | null,
  release: boolean,
): Promise<void> {
  if (release) await releaseRemaining(client, orderId);
  await client.query(
    `UPDATE order_holds SET status = $2, updated_at = now() WHERE engine_order_id = $1`,
    [orderId, status === "open" ? "open" : status],
  );
  await client.query(
    `UPDATE user_orders SET status = $2, reject_reason = $3, updated_at = now() WHERE engine_order_id = $1`,
    [orderId, status, rejectReason],
  );
}

export async function markOpen(client: Client, orderId: string): Promise<void> {
  await client.query(
    `UPDATE order_holds SET status = 'open', updated_at = now() WHERE engine_order_id = $1 AND status = 'pending'`,
    [orderId],
  );
  await client.query(
    `UPDATE user_orders SET status = CASE WHEN filled_mg > 0 THEN 'open' ELSE 'open' END, updated_at = now()
     WHERE engine_order_id = $1`,
    [orderId],
  );
}

export type Invariant = { name: string; ok: boolean; detail: string };

export async function checkInvariants(client: Client): Promise<Invariant[]> {
  const out: Invariant[] = [];
  const neg = await client.query(`SELECT count(*)::text AS n FROM balances WHERE amount < 0`);
  out.push({ name: "no_negative_balances", ok: neg.rows[0].n === "0", detail: `negatives=${neg.rows[0].n}` });

  const trial = await client.query(`
    SELECT a.entity_id, a.asset,
      COALESCE(SUM(b.amount) FILTER (WHERE a.account_type = 'asset'), 0)::text AS assets,
      COALESCE(SUM(b.amount) FILTER (WHERE a.account_type = 'liability'), 0)::text AS liabilities
    FROM accounts a
    JOIN balances b ON b.account_id = a.id
    GROUP BY a.entity_id, a.asset
    ORDER BY a.entity_id, a.asset
  `);
  let trialOk = true;
  const trialDetail: string[] = [];
  for (const row of trial.rows) {
    const match = row.assets === row.liabilities;
    if (!match) trialOk = false;
    trialDetail.push(`${row.entity_id}/${row.asset} assets=${row.assets} liabilities=${row.liabilities}`);
  }
  out.push({ name: "trial_balance_per_entity_asset", ok: trialOk, detail: trialDetail.join("; ") });

  const cons = await client.query(`
    SELECT a.asset,
      COALESCE(SUM(b.amount) FILTER (WHERE a.bucket IN ('available','reserved','withdraw_hold','margin','derivatives')), 0)::text AS customer,
      COALESCE(SUM(b.amount) FILTER (WHERE a.bucket IN ('bank','vault')), 0)::text AS omnibus
    FROM accounts a JOIN balances b ON b.account_id = a.id
    GROUP BY a.asset
  `);
  for (const row of cons.rows) {
    out.push({
      name: `conservation_${row.asset}`,
      ok: row.customer === row.omnibus,
      detail: `customer=${row.customer} omnibus=${row.omnibus}`,
    });
  }

  const pairs = [
    ["SG-OPCO", "MY-ENTITY", "USD"],
    ["MY-ENTITY", "SG-OPCO", "USD"],
    ["SG-OPCO", "MY-ENTITY", "XAU"],
    ["MY-ENTITY", "SG-OPCO", "XAU"],
  ] as const;
  for (const [from, to, asset] of pairs) {
    const dueTo = await client.query(
      `SELECT COALESCE(b.amount,0)::text AS n
       FROM accounts a JOIN balances b ON b.account_id = a.id
       WHERE a.entity_id = $1 AND a.code = $2`,
      [from, `intercompany:${to}:${asset}:due_to`],
    );
    const dueFrom = await client.query(
      `SELECT COALESCE(b.amount,0)::text AS n
       FROM accounts a JOIN balances b ON b.account_id = a.id
       WHERE a.entity_id = $1 AND a.code = $2`,
      [to, `intercompany:${from}:${asset}:due_from`],
    );
    const a = dueTo.rows[0]?.n ?? "0";
    const b = dueFrom.rows[0]?.n ?? "0";
    out.push({
      name: `intercompany_${from}_due_to_${to}_${asset}`,
      ok: a === b,
      detail: `due_to=${a} due_from=${b}`,
    });
  }

  const reserved = await client.query(`
    WITH parts AS (
      SELECT COALESCE(quote_asset, 'USD') AS asset, reserved_uusd AS n
      FROM order_holds WHERE status IN ('pending','open','armed')
      UNION ALL
      SELECT COALESCE(base_asset, 'XAU'), reserved_mg
      FROM order_holds WHERE status IN ('pending','open','armed')
    ),
    holds AS (
      SELECT asset, COALESCE(SUM(n), 0) AS n FROM parts GROUP BY asset
    ),
    bals AS (
      SELECT a.asset, COALESCE(SUM(b.amount), 0) AS n
      FROM accounts a JOIN balances b ON b.account_id = a.id
      WHERE a.bucket = 'reserved'
      GROUP BY a.asset
    )
    SELECT COALESCE(h.asset, b.asset) AS asset,
           COALESCE(h.n, 0)::text AS hold_n,
           COALESCE(b.n, 0)::text AS bal_n
    FROM holds h FULL OUTER JOIN bals b ON b.asset = h.asset
  `);
  const mismatch = reserved.rows.filter((row) => row.hold_n !== row.bal_n);
  out.push({
    name: "reserved_matches_open_holds",
    ok: mismatch.length === 0,
    detail: mismatch.length
      ? mismatch.map((row) => `${row.asset} holds=${row.hold_n} bal=${row.bal_n}`).join("; ")
      : `assets=${reserved.rowCount}`,
  });

  const covered = await client.query(`
    WITH locked AS (
      SELECT user_id,
             CASE WHEN product = 'margin' THEN 'margin' ELSE 'derivatives' END AS bucket,
             margin_uusd AS n
      FROM real_positions WHERE status = 'open'
      UNION ALL
      SELECT user_id,
             CASE WHEN product = 'margin' THEN 'margin' ELSE 'derivatives' END,
             reserved_margin_uusd
      FROM real_orders WHERE status = 'open' AND reserved_margin_uusd > 0
    ),
    need AS (
      SELECT user_id, bucket, COALESCE(SUM(n), 0) AS n FROM locked GROUP BY user_id, bucket
    ),
    bals AS (
      SELECT a.customer_id AS user_id, a.bucket, COALESCE(SUM(b.amount), 0) AS n
      FROM accounts a JOIN balances b ON b.account_id = a.id
      WHERE a.bucket IN ('margin', 'derivatives') AND a.asset = 'USD'
      GROUP BY a.customer_id, a.bucket
    )
    SELECT n.user_id::text, n.bucket, n.n::text AS need_n, COALESCE(b.n, 0)::text AS bal_n
    FROM need n LEFT JOIN bals b ON b.user_id = n.user_id AND b.bucket = n.bucket
    WHERE COALESCE(b.n, 0) < n.n
  `);
  out.push({
    name: "live_wallet_covers_margin",
    ok: covered.rowCount === 0,
    detail: covered.rowCount
      ? covered.rows.map((row) => `${row.user_id}/${row.bucket} need=${row.need_n} bal=${row.bal_n}`).join("; ")
      : "covered",
  });
  return out;
}

export function clearAccountCache(): void {
  cache.clear();
}
