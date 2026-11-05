import type { Db } from "./db.js";
import { withTx } from "./db.js";
import type { EngineClient } from "./engineClient.js";
import { hashPassword } from "./crypto.js";
import { decideKyc, type Policy } from "./kyc.js";
import { ensurePolicy } from "./policy.js";
import { deposit, ensureCustomer, type CustomerRef } from "./ledger.js";
import { DEMO } from "./units.js";
import { placeOrder } from "./trading.js";

const USD = 1_000_000n;

type Person = {
  email: string;
  password: string;
  secret: string;
  role: "customer" | "admin" | "bot";
  nationality: string;
  residence: string;
  sanctions: boolean;
  usd: bigint;
  mg: bigint;
  holdPending?: boolean;
};

function people(): Person[] {
  return [
    {
      email: DEMO.email,
      password: DEMO.password,
      secret: DEMO.totpSecret,
      role: "customer",
      nationality: "SG",
      residence: "SG",
      sanctions: false,
      usd: 250_000n * USD,
      mg: 1_200_000n,
    },
    {
      email: DEMO.adminEmail,
      password: DEMO.adminPassword,
      secret: DEMO.adminTotpSecret,
      role: "admin",
      nationality: "SG",
      residence: "SG",
      sanctions: false,
      usd: 20_000n * USD,
      mg: 50_000n,
    },
    {
      email: "mei.tan@meridexexchange.com",
      password: DEMO.password,
      secret: "<redacted>",
      role: "customer",
      nationality: "SG",
      residence: "SG",
      sanctions: false,
      usd: 80_000n * USD,
      mg: 400_000n,
    },
    {
      email: "harris.ong@meridexexchange.com",
      password: DEMO.password,
      secret: "<redacted>",
      role: "customer",
      nationality: "SG",
      residence: "SG",
      sanctions: false,
      usd: 120_000n * USD,
      mg: 250_000n,
    },
    {
      email: "farah.lim@meridexexchange.com",
      password: DEMO.password,
      secret: "<redacted>",
      role: "customer",
      nationality: "MY",
      residence: "MY",
      sanctions: false,
      usd: 0n,
      mg: 0n,
      holdPending: true,
    },
    {
      email: "hk.chen@meridexexchange.com",
      password: DEMO.password,
      secret: "<redacted>",
      role: "customer",
      nationality: "HK",
      residence: "HK",
      sanctions: false,
      usd: 40_000n * USD,
      mg: 50_000n,
    },
    {
      email: "jp.sato@meridexexchange.com",
      password: DEMO.password,
      secret: "<redacted>",
      role: "customer",
      nationality: "JP",
      residence: "JP",
      sanctions: false,
      usd: 40_000n * USD,
      mg: 50_000n,
    },
    {
      email: "th.somchai@meridexexchange.com",
      password: DEMO.password,
      secret: "<redacted>",
      role: "customer",
      nationality: "TH",
      residence: "TH",
      sanctions: false,
      usd: 40_000n * USD,
      mg: 50_000n,
    },
    {
      email: "ae.nasser@meridexexchange.com",
      password: DEMO.password,
      secret: "<redacted>",
      role: "customer",
      nationality: "AE",
      residence: "AE",
      sanctions: false,
      usd: 40_000n * USD,
      mg: 50_000n,
    },
    {
      email: "wei.lin@meridexexchange.com",
      password: DEMO.password,
      secret: "<redacted>",
      role: "customer",
      nationality: "CN",
      residence: "CN",
      sanctions: false,
      usd: 40_000n * USD,
      mg: 50_000n,
    },
    {
      email: "james.walker@meridexexchange.com",
      password: DEMO.password,
      secret: "<redacted>",
      role: "customer",
      nationality: "US",
      residence: "US",
      sanctions: false,
      usd: 90_000n * USD,
      mg: 100_000n,
    },
    {
      email: "aisha.rahman@meridexexchange.com",
      password: DEMO.password,
      secret: "<redacted>",
      role: "customer",
      nationality: "US",
      residence: "US",
      sanctions: false,
      usd: 60_000n * USD,
      mg: 40_000n,
    },
    {
      email: "nadia.karim@meridexexchange.com",
      password: DEMO.password,
      secret: "<redacted>",
      role: "customer",
      nationality: "SG",
      residence: "SG",
      sanctions: true,
      usd: 0n,
      mg: 0n,
    },
    {
      email: "bot-mm@internal.meridex",
      password: crypto.randomUUID(),
      secret: "<redacted>",
      role: "bot",
      nationality: "SG",
      residence: "SG",
      sanctions: false,
      usd: 5_000_000n * USD,
      mg: 50_000_000n,
    },
    {
      email: "bot-flow@internal.meridex",
      password: crypto.randomUUID(),
      secret: "<redacted>",
      role: "bot",
      nationality: "SG",
      residence: "SG",
      sanctions: false,
      usd: 5_000_000n * USD,
      mg: 50_000_000n,
    },
  ];
}

function decisionFor(person: Person, policy: Policy) {
  const decision = decideKyc({
    nationality: person.nationality,
    residenceCountry: person.residence,
    sanctionsHit: person.sanctions,
  }, policy);
  if (!person.holdPending) return decision;
  return { ...decision, decision: "pending" as const, trading: false, status: "pending" as const, reason: "KYC_PENDING" };
}

async function insertPerson(pool: Db, person: Person, policy: Policy): Promise<CustomerRef | null> {
  const decision = decisionFor(person, policy);
  const passwordHash = hashPassword(person.password);
  const created = await pool.query(
    `INSERT INTO users (email, password_hash, totp_secret, role, entity_id, jurisdiction)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (email) DO NOTHING
     RETURNING id`,
    [
      person.email,
      passwordHash,
      person.secret,
      person.role,
      decision.entityId,
      decision.entityId ? person.residence : null,
    ],
  );
  if (!created.rowCount) return null;
  const id = Number(created.rows[0].id);
  await pool.query(
    `INSERT INTO kyc_profiles (user_id, nationality, residence_country, sanctions_hit, status, reason, entity_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, person.nationality, person.residence, person.sanctions, decision.status, decision.reason, decision.entityId],
  );
  if (!decision.entityId) return null;
  const user: CustomerRef = { id, entityId: decision.entityId, jurisdiction: person.residence };
  if (decision.trading && (person.usd > 0n || person.mg > 0n)) {
    await withTx(pool, async (client) => {
      await ensureCustomer(client, user);
      if (person.usd > 0n) await deposit(client, user, "USD", person.usd);
      if (person.mg > 0n) await deposit(client, user, "XAU", person.mg);
    });
  } else {
    await withTx(pool, (client) => ensureCustomer(client, user));
  }
  return user;
}

async function refreshPerson(pool: Db, person: Person, policy: Policy): Promise<void> {
  const decision = decisionFor(person, policy);
  const found = await pool.query(`SELECT id FROM users WHERE email = $1`, [person.email]);
  if (!found.rowCount) {
    await insertPerson(pool, person, policy);
    return;
  }
  const id = Number(found.rows[0].id);
  const jurisdiction = decision.entityId ? person.residence : null;
  await pool.query(`UPDATE users SET entity_id = $2, jurisdiction = $3 WHERE id = $1`, [
    id,
    decision.entityId,
    jurisdiction,
  ]);
  await pool.query(
    `INSERT INTO kyc_profiles (user_id, nationality, residence_country, sanctions_hit, status, reason, entity_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (user_id) DO UPDATE SET
       nationality = EXCLUDED.nationality,
       residence_country = EXCLUDED.residence_country,
       sanctions_hit = EXCLUDED.sanctions_hit,
       status = EXCLUDED.status,
       reason = EXCLUDED.reason,
       entity_id = EXCLUDED.entity_id,
       updated_at = now()`,
    [id, person.nationality, person.residence, person.sanctions, decision.status, decision.reason, decision.entityId],
  );
  if (!decision.entityId || !decision.trading) return;
  const user: CustomerRef = { id, entityId: decision.entityId, jurisdiction: person.residence };
  const held = await pool.query(
    `SELECT COALESCE(SUM(b.amount), 0)::text AS n
     FROM accounts a JOIN balances b ON b.account_id = a.id
     WHERE a.customer_id = $1`,
    [id],
  );
  if (held.rows[0].n !== "0") {
    await withTx(pool, (client) => ensureCustomer(client, user));
    return;
  }
  await withTx(pool, async (client) => {
    await ensureCustomer(client, user);
    if (person.usd > 0n) await deposit(client, user, "USD", person.usd);
    if (person.mg > 0n) await deposit(client, user, "XAU", person.mg);
  });
}

function legacyBrand(): string {
  return ["a", "u", "r", "u", "m"].join("");
}

async function renameLegacyAddresses(pool: Db) {
  const brand = legacyBrand();
  await pool.query(
    `UPDATE users SET email = replace(email, $1, '@meridexexchange.com') WHERE email LIKE '%@' || $2 || '.sg'`,
    [`@${brand}.sg`, brand],
  );
  await pool.query(
    `UPDATE users SET email = replace(email, '@meridex.sg', '@meridexexchange.com') WHERE email LIKE '%@meridex.sg'`,
  );
  await pool.query(
    `UPDATE users SET email = replace(email, $1, '@internal.meridex') WHERE email LIKE '%@internal.' || $2`,
    [`@internal.${brand}`, brand],
  );
  await pool.query(
    `UPDATE users SET referral_code = 'MERIDEX-SG'
     WHERE referral_code = $1 OR (email = 'client@meridexexchange.com' AND referral_code IS NULL)`,
    [`${brand.toUpperCase()}-DEMO`],
  );
}

async function syncCredentials(pool: Db) {
  for (const person of people()) {
    if (person.role === "bot") {
      await pool.query(`UPDATE users SET totp_secret = $2 WHERE email = $1 AND totp_secret IS DISTINCT FROM $2`, [
        person.email,
        person.secret,
      ]);
      continue;
    }
    await pool.query(`UPDATE users SET password_hash = $2, totp_secret = $3 WHERE email = $1`, [
      person.email,
      hashPassword(person.password),
      person.secret,
    ]);
  }
}

export async function seedDemo(pool: Db, engine: EngineClient): Promise<void> {
  await renameLegacyAddresses(pool);
  const policy = await ensurePolicy(pool);
  const existing = await pool.query(`SELECT id FROM users WHERE email = $1`, [DEMO.email]);
  if (!existing.rowCount) {
    for (const person of people()) await insertPerson(pool, person, policy);
    await pool.query(
      `INSERT INTO geo_alerts (user_id, ip, ip_country, residence_country, action, path, detail)
       SELECT id, '203.0.113.30', 'MY', 'SG', 'alert', '/api/orders', '预置：居住地新加坡，模拟来源在马来西亚'
       FROM users WHERE email = $1`,
      [DEMO.email],
    );
    console.log("seed: demo accounts created");
  } else {
    for (const email of [
      "james.walker@meridexexchange.com",
      "aisha.rahman@meridexexchange.com",
      "nadia.karim@meridexexchange.com",
      "farah.lim@meridexexchange.com",
      "hk.chen@meridexexchange.com",
      "jp.sato@meridexexchange.com",
      "th.somchai@meridexexchange.com",
      "ae.nasser@meridexexchange.com",
      "wei.lin@meridexexchange.com",
    ]) {
      const person = people().find((row) => row.email === email);
      if (person) await refreshPerson(pool, person, policy);
    }
    await pool.query(`DELETE FROM geo_alerts WHERE detail LIKE '%美国居住地%'`);
  }
  await syncCredentials(pool);
  const trades = await pool.query(`SELECT count(*)::int AS n FROM trades`);
  if (trades.rows[0].n > 0) return;
  const mm = await loadBot(pool, "bot-mm@internal.meridex");
  const flow = await loadBot(pool, "bot-flow@internal.meridex");
  if (!mm || !flow) return;
  let price = 12970;
  for (let i = 0; i < 48; i++) {
    price += Math.round((Math.random() - 0.48) * 7);
    price = Math.max(12920, Math.min(13080, price));
    const qty = BigInt(400 + (i % 5) * 120);
    try {
      if (i % 2 === 0) {
        await placeOrder(pool, engine, mm, { side: "sell", orderType: "limit", priceCents: BigInt(price), qtyMg: qty });
        await placeOrder(pool, engine, flow, { side: "buy", orderType: "ioc", priceCents: BigInt(price), qtyMg: qty });
      } else {
        await placeOrder(pool, engine, mm, { side: "buy", orderType: "limit", priceCents: BigInt(price), qtyMg: qty });
        await placeOrder(pool, engine, flow, { side: "sell", orderType: "ioc", priceCents: BigInt(price), qtyMg: qty });
      }
    } catch (err) {
      console.error("warmup trade skipped", err);
    }
  }
  await pool.query(`
    WITH ranked AS (
      SELECT id, row_number() OVER (ORDER BY id) AS rn, count(*) OVER () AS n FROM trades
    )
    UPDATE trades t
    SET tape_at = now() - ((r.n - r.rn) * interval '100 seconds')
    FROM ranked r
    WHERE t.id = r.id
  `);
  await quote(pool, engine, mm);
  console.log("seed: warmup tape and opening book are in place");
}

export async function loadBot(pool: Db, email: string): Promise<CustomerRef | null> {
  const row = await pool.query(
    `SELECT id, entity_id, jurisdiction FROM users WHERE email = $1 AND role = 'bot'`,
    [email],
  );
  if (!row.rowCount) return null;
  return {
    id: Number(row.rows[0].id),
    entityId: row.rows[0].entity_id,
    jurisdiction: row.rows[0].jurisdiction,
  };
}

export async function quote(pool: Db, engine: EngineClient, mm: CustomerRef): Promise<void> {
  const open = await pool.query(
    `SELECT engine_order_id FROM user_orders WHERE user_id = $1 AND status = 'open' AND symbol = 'XAU/USD'`,
    [mm.id],
  );
  for (const row of open.rows) {
    try {
      const { cancelOrder } = await import("./trading.js");
      await cancelOrder(pool, engine, mm, row.engine_order_id as string);
    } catch {
      /* already gone */
    }
  }
  const book = await engine.book();
  let mid = book.last_trade_price ?? book.reference_price;
  if (Math.abs(mid - book.reference_price) > 60) {
    mid += Math.sign(book.reference_price - mid) * 2;
  }
  const sizes = [8_000, 12_000, 20_000, 15_000, 9_000];
  for (let i = 0; i < sizes.length; i++) {
    const bid = mid - 2 - i * 3;
    const ask = mid + 2 + i * 3;
    const qty = BigInt(sizes[i]);
    if (bid >= book.halt_low) {
      await placeOrder(pool, engine, mm, { side: "buy", orderType: "post_only", priceCents: BigInt(bid), qtyMg: qty }).catch(
        () => undefined,
      );
    }
    if (ask <= book.halt_high) {
      await placeOrder(pool, engine, mm, { side: "sell", orderType: "post_only", priceCents: BigInt(ask), qtyMg: qty }).catch(
        () => undefined,
      );
    }
  }
}

/** XAU/USD is quoted by the maker loop, which follows the live gold-api anchor. */
export function startBots(
  _pool: Db,
  _engine: EngineClient,
  _mm: CustomerRef,
  _flow: CustomerRef,
  _after: () => Promise<void>,
): void {
  console.log("xau quoting is owned by the maker loop");
}
