import type { Db } from "../db.js";
import { withTx } from "../db.js";
import { quoteNotional, type Instrument } from "../instruments.js";
import { LedgerError, postLpSpot, walletAmount, type CustomerRef } from "../ledger.js";
import { providerFor } from "./registry.js";
import { cancelHedge, logShadow, markHedgeUnapplied, planRoute, sendHedge, type Plan } from "./route.js";
import { LpError, applyMarkup, mapSymbol, type Side, type Venue } from "./types.js";

const immediate = new Set(["market", "ioc", "fok"]);

export async function spotPlan(pool: Db, userId: number, venue: Venue, asset: string): Promise<Plan> {
  return planRoute(pool, { venue, asset, userId });
}

export async function rememberShadow(
  pool: Db,
  plan: Plan,
  input: {
    userId: number;
    venue: Venue;
    asset: string;
    symbol: string;
    side: Side;
    qty: bigint;
    internalPx: bigint | null;
    filledQty: bigint;
    status: string;
  },
) {
  if (plan.kind !== "shadow") return;
  await logShadow(pool, plan.provider, input);
}

export async function liveSpot(
  pool: Db,
  user: CustomerRef,
  inst: Instrument,
  input: { side: Side; orderType: string; priceCents: bigint | null; qty: bigint; venue: Venue },
  timeoutMs = 3000,
): Promise<{
  orderId: string;
  status: string;
  rejectReason: string | null;
  filledMg: string;
  leavesMg: string;
  trades: { price: number; qty: number; tradeId: string }[];
  lpExternal: boolean;
}> {
  const plan = await planRoute(pool, { venue: input.venue, asset: inst.base, userId: user.id });
  if (plan.kind === "internal" || plan.kind === "shadow") {
    throw new LedgerError("VALIDATION");
  }
  if (plan.kind === "killed") throw new LedgerError("LP_KILLED");
  if (!immediate.has(input.orderType)) throw new LedgerError("LP_RESTING");
  const quote = await providerFor(plan.provider).quote(mapSymbol(plan.provider, inst.symbol));
  const raw = input.side === "buy" ? quote?.ask ?? input.priceCents : quote?.bid ?? input.priceCents;
  const guardPx = raw && raw > 0n ? applyMarkup(raw, input.side, plan.provider.spreadMarkupBps) : input.priceCents;
  if (input.side === "buy") {
    if (!guardPx || guardPx <= 0n) throw new LedgerError("LP_REJECTED");
    const need = quoteNotional(input.qty, guardPx, inst);
    await withTx(pool, async (client) => {
      const have = await walletAmount(client, user, inst.quote, "available");
      if (have < need) throw new LedgerError("INSUFFICIENT_FUNDS");
    });
  } else {
    await withTx(pool, async (client) => {
      const have = await walletAmount(client, user, inst.base, "available");
      if (have < input.qty) throw new LedgerError(inst.base === "XAU" ? "INSUFFICIENT_GOLD" : "INSUFFICIENT_FUNDS");
    });
  }
  const notionalGuess = guardPx && guardPx > 0n ? quoteNotional(input.qty, guardPx, inst) : 0n;
  let hedge;
  try {
    hedge = await sendHedge(pool, plan, {
      userId: user.id,
      venue: input.venue,
      asset: inst.base,
      symbol: inst.symbol,
      side: input.side,
      qty: input.qty,
      limitPx: input.orderType === "market" ? null : input.priceCents,
      notionalUusd: notionalGuess > 0n ? notionalGuess : 1n,
      internalPx: input.priceCents,
      qtyScale: inst.qtyScale,
      priceScale: inst.priceScale,
      quoteScale: inst.quoteScale,
    }, timeoutMs);
  } catch (err) {
    if (err instanceof LpError) throw new LedgerError(err.code);
    throw err;
  }
  if (hedge.filledQty <= 0n) throw new LedgerError("LP_REJECTED");
  const px = hedge.customerPx > 0n ? hedge.customerPx : hedge.avgPx;
  const notional = quoteNotional(hedge.filledQty, px, inst);
  const orderId = hedge.clientOrderId;
  try {
    await withTx(pool, (client) =>
      postLpSpot(client, user, {
        orderId,
        symbol: inst.symbol,
        base: inst.base,
        quote: inst.quote,
        side: input.side,
        orderType: input.orderType,
        qty: hedge.filledQty,
        price: px,
        notional,
        qtyScale: BigInt(inst.qtyScale),
        priceScale: BigInt(inst.priceScale),
        quoteScale: BigInt(inst.quoteScale),
      }),
    );
  } catch (err) {
    await markHedgeUnapplied(pool, hedge.clientOrderId);
    await cancelHedge(pool, hedge.providerId, hedge.clientOrderId);
    throw err;
  }
  const leaves = input.qty - hedge.filledQty;
  return {
    orderId,
    status: "filled",
    rejectReason: null,
    filledMg: hedge.filledQty.toString(),
    leavesMg: leaves.toString(),
    trades: [{ price: Number(px), qty: Number(hedge.filledQty), tradeId: `lp:${orderId}` }],
    lpExternal: true,
  };
}
