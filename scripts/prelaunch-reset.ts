/**
 * Dry-run by default.
 * --confirm --totp <code> takes a pg_dump, then removes sandbox customers,
 * play-money and paper ledgers, sample orders, and seed content.
 * The owner account, business_params, content_overrides, and address_pool stay.
 * A wrong TOTP is checked locally and does not increment the login lockout.
 * Confirm is refused while the live gateway still has SEED_DEMO or BOTS on,
 * because the next request would recreate the seed.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { verifyTotp } from "../gateway/src/crypto.ts";
import {
  findGateway,
  databaseUrl,
  openPool,
  REMOVAL_EMAILS,
  REMOVAL_IDS,
  root,
  SEED_CONTENT,
} from "./prelaunch-lib.ts";

const R = REMOVAL_IDS;

const HANDLED = new Set([
  "users.account_manager_id",
  "users.referred_by",
  "kyc_profiles.user_id",
  "geo_alerts.user_id",
  "accounts.customer_id",
  "activity.user_id",
  "address_history.user_id",
  "address_pool.user_id",
  "agent_tasks.assignee_id",
  "agent_tasks.user_id",
  "api_keys.user_id",
  "business_params.updated_by",
  "change_requests.checker_id",
  "change_requests.maker_id",
  "chat_messages.author_id",
  "chat_messages.user_id",
  "content_audit.actor_id",
  "content_overrides.updated_by",
  "convert_fills.user_id",
  "convert_quotes.user_id",
  "crypto_transfers.user_id",
  "deposit_claims.user_id",
  "deposit_profiles.user_id",
  "deposit_records.user_id",
  "equity_snapshots.user_id",
  "login_events.user_id",
  "manual_deposits.actor_id",
  "manual_deposits.reverse_actor_id",
  "manual_deposits.user_id",
  "notification_outbox.user_id",
  "notification_prefs.user_id",
  "order_holds.user_id",
  "paper_balances.user_id",
  "paper_copy_follows.user_id",
  "paper_copy_trades.user_id",
  "paper_margin.user_id",
  "paper_orders.user_id",
  "paper_perps.user_id",
  "paper_trades.user_id",
  "paper_wallets.user_id",
  "play_balances.user_id",
  "play_moves.actor_id",
  "play_moves.user_id",
  "play_orders.user_id",
  "play_trades.user_id",
  "price_alerts.user_id",
  "rail_transfers.user_id",
  "recurring_plans.user_id",
  "recurring_runs.user_id",
  "redemptions.user_id",
  "referrals.invitee_id",
  "referrals.inviter_id",
  "risk_case_notes.actor_id",
  "risk_cases.assignee_id",
  "risk_cases.subject_user_id",
  "security_events.user_id",
  "sessions.user_id",
  "surv_alerts.user_id",
  "ticket_messages.author_id",
  "tickets.assignee_id",
  "tickets.user_id",
  "totp_lockouts.user_id",
  "user_notices.user_id",
  "user_orders.user_id",
  "user_tasks.user_id",
  "watchlist.user_id",
  "withdrawal_addresses.user_id",
  "withdrawal_requests.actor_id",
  "withdrawal_requests.user_id",
]);

type Step = { label: string; count: string; sql: string; params?: boolean };

const steps: Step[] = [
  { label: "play_trades", count: `SELECT count(*)::int AS n FROM play_trades`, sql: `DELETE FROM play_trades` },
  { label: "play_orders", count: `SELECT count(*)::int AS n FROM play_orders`, sql: `DELETE FROM play_orders` },
  { label: "play_moves", count: `SELECT count(*)::int AS n FROM play_moves`, sql: `DELETE FROM play_moves` },
  { label: "play_balances", count: `SELECT count(*)::int AS n FROM play_balances`, sql: `DELETE FROM play_balances` },
  { label: "paper_copy_trades", count: `SELECT count(*)::int AS n FROM paper_copy_trades`, sql: `DELETE FROM paper_copy_trades` },
  { label: "paper_copy_follows", count: `SELECT count(*)::int AS n FROM paper_copy_follows`, sql: `DELETE FROM paper_copy_follows` },
  { label: "paper_trades", count: `SELECT count(*)::int AS n FROM paper_trades`, sql: `DELETE FROM paper_trades` },
  { label: "paper_orders", count: `SELECT count(*)::int AS n FROM paper_orders`, sql: `DELETE FROM paper_orders` },
  { label: "paper_margin", count: `SELECT count(*)::int AS n FROM paper_margin`, sql: `DELETE FROM paper_margin` },
  { label: "paper_perps", count: `SELECT count(*)::int AS n FROM paper_perps`, sql: `DELETE FROM paper_perps` },
  { label: "paper_balances", count: `SELECT count(*)::int AS n FROM paper_balances`, sql: `DELETE FROM paper_balances` },
  { label: "equity_snapshots", count: `SELECT count(*)::int AS n FROM equity_snapshots`, sql: `DELETE FROM equity_snapshots` },
  { label: "paper_wallets", count: `SELECT count(*)::int AS n FROM paper_wallets`, sql: `DELETE FROM paper_wallets` },
  {
    label: "seed_trades",
    count: `SELECT count(*)::int AS n FROM trades WHERE buyer_id IN ${R} AND seller_id IN ${R}`,
    sql: `DELETE FROM trades WHERE buyer_id IN ${R} AND seller_id IN ${R}`,
    params: true,
  },
  {
    label: "risk_case_notes",
    count: `SELECT count(*)::int AS n FROM risk_case_notes WHERE case_id IN (
      SELECT id FROM risk_cases WHERE id = ANY($$CASES) OR subject_user_id IN ${R}
      OR alert_id IN (SELECT id FROM surv_alerts WHERE demo OR user_id IN ${R})
    ) OR actor_id IN ${R}`,
    sql: `DELETE FROM risk_case_notes WHERE case_id IN (
      SELECT id FROM risk_cases WHERE id = ANY($$CASES) OR subject_user_id IN ${R}
      OR alert_id IN (SELECT id FROM surv_alerts WHERE demo OR user_id IN ${R})
    ) OR actor_id IN ${R}`,
    params: true,
  },
  {
    label: "risk_cases",
    count: `SELECT count(*)::int AS n FROM risk_cases WHERE id = ANY($$CASES) OR subject_user_id IN ${R}
      OR alert_id IN (SELECT id FROM surv_alerts WHERE demo OR user_id IN ${R})`,
    sql: `DELETE FROM risk_cases WHERE id = ANY($$CASES) OR subject_user_id IN ${R}
      OR alert_id IN (SELECT id FROM surv_alerts WHERE demo OR user_id IN ${R})`,
    params: true,
  },
  {
    label: "surv_alerts_demo",
    count: `SELECT count(*)::int AS n FROM surv_alerts WHERE demo OR user_id IN ${R}`,
    sql: `DELETE FROM surv_alerts WHERE demo OR user_id IN ${R}`,
    params: true,
  },
  {
    label: "surv_events",
    count: `SELECT count(*)::int AS n FROM surv_events WHERE user_id IN ${R}`,
    sql: `DELETE FROM surv_events WHERE user_id IN ${R}`,
    params: true,
  },
  {
    label: "ticket_messages",
    count: `SELECT count(*)::int AS n FROM ticket_messages WHERE author_id IN ${R}
      OR ticket_id IN (SELECT id FROM tickets WHERE user_id IN ${R})`,
    sql: `DELETE FROM ticket_messages WHERE author_id IN ${R}
      OR ticket_id IN (SELECT id FROM tickets WHERE user_id IN ${R})`,
    params: true,
  },
  { label: "tickets", count: `SELECT count(*)::int AS n FROM tickets WHERE user_id IN ${R}`, sql: `DELETE FROM tickets WHERE user_id IN ${R}`, params: true },
  {
    label: "convert_fills",
    count: `SELECT count(*)::int AS n FROM convert_fills WHERE user_id IN ${R}`,
    sql: `DELETE FROM convert_fills WHERE user_id IN ${R}`,
    params: true,
  },
  {
    label: "convert_quotes",
    count: `SELECT count(*)::int AS n FROM convert_quotes WHERE user_id IN ${R}`,
    sql: `DELETE FROM convert_quotes WHERE user_id IN ${R}`,
    params: true,
  },
  {
    label: "recurring_runs",
    count: `SELECT count(*)::int AS n FROM recurring_runs WHERE user_id IN ${R}`,
    sql: `DELETE FROM recurring_runs WHERE user_id IN ${R}`,
    params: true,
  },
  {
    label: "recurring_plans",
    count: `SELECT count(*)::int AS n FROM recurring_plans WHERE user_id IN ${R}`,
    sql: `DELETE FROM recurring_plans WHERE user_id IN ${R}`,
    params: true,
  },
  {
    label: "user_tasks",
    count: `SELECT count(*)::int AS n FROM user_tasks WHERE user_id IN ${R} OR task_id = ANY($$TASKS)`,
    sql: `DELETE FROM user_tasks WHERE user_id IN ${R} OR task_id = ANY($$TASKS)`,
    params: true,
  },
  {
    label: "reward_tasks",
    count: `SELECT count(*)::int AS n FROM reward_tasks WHERE id = ANY($$TASKS)`,
    sql: `DELETE FROM reward_tasks WHERE id = ANY($$TASKS)`,
    params: true,
  },
  {
    label: "referrals",
    count: `SELECT count(*)::int AS n FROM referrals WHERE inviter_id IN ${R} OR invitee_id IN ${R}`,
    sql: `DELETE FROM referrals WHERE inviter_id IN ${R} OR invitee_id IN ${R}`,
    params: true,
  },
  {
    label: "chat_messages",
    count: `SELECT count(*)::int AS n FROM chat_messages WHERE user_id IN ${R} OR author_id IN ${R}`,
    sql: `DELETE FROM chat_messages WHERE user_id IN ${R} OR author_id IN ${R}`,
    params: true,
  },
  {
    label: "order_holds",
    count: `SELECT count(*)::int AS n FROM order_holds WHERE user_id IN ${R}`,
    sql: `DELETE FROM order_holds WHERE user_id IN ${R}`,
    params: true,
  },
  {
    label: "user_orders",
    count: `SELECT count(*)::int AS n FROM user_orders WHERE user_id IN ${R}`,
    sql: `DELETE FROM user_orders WHERE user_id IN ${R}`,
    params: true,
  },
  {
    label: "deposit_claims",
    count: `SELECT count(*)::int AS n FROM deposit_claims WHERE user_id IN ${R}`,
    sql: `DELETE FROM deposit_claims WHERE user_id IN ${R}`,
    params: true,
  },
  {
    label: "manual_deposits",
    count: `SELECT count(*)::int AS n FROM manual_deposits WHERE user_id IN ${R}`,
    sql: `DELETE FROM manual_deposits WHERE user_id IN ${R}`,
    params: true,
  },
  {
    label: "withdrawal_requests",
    count: `SELECT count(*)::int AS n FROM withdrawal_requests WHERE user_id IN ${R}`,
    sql: `DELETE FROM withdrawal_requests WHERE user_id IN ${R}`,
    params: true,
  },
  {
    label: "ledger_entries",
    count: `SELECT count(*)::int AS n FROM journal_entries e WHERE EXISTS (
      SELECT 1 FROM postings p JOIN accounts a ON a.id = p.account_id
      WHERE p.entry_id = e.id AND a.customer_id IN ${R}
    ) AND NOT EXISTS (
      SELECT 1 FROM postings p JOIN accounts a ON a.id = p.account_id
      WHERE p.entry_id = e.id AND a.customer_id IS NOT NULL AND a.customer_id NOT IN ${R}
    )`,
    sql: `WITH doomed AS (
      SELECT e.id FROM journal_entries e WHERE EXISTS (
        SELECT 1 FROM postings p JOIN accounts a ON a.id = p.account_id
        WHERE p.entry_id = e.id AND a.customer_id IN ${R}
      ) AND NOT EXISTS (
        SELECT 1 FROM postings p JOIN accounts a ON a.id = p.account_id
        WHERE p.entry_id = e.id AND a.customer_id IS NOT NULL AND a.customer_id NOT IN ${R}
      )
    ), gone AS (
      DELETE FROM postings WHERE entry_id IN (SELECT id FROM doomed) RETURNING entry_id
    )
    DELETE FROM journal_entries WHERE id IN (SELECT id FROM doomed)`,
    params: true,
  },
  {
    label: "customer_accounts",
    count: `SELECT count(*)::int AS n FROM accounts WHERE customer_id IN ${R}`,
    sql: `DELETE FROM balances WHERE account_id IN (SELECT id FROM accounts WHERE customer_id IN ${R})`,
    params: true,
  },
  {
    label: "customer_account_rows",
    count: `SELECT count(*)::int AS n FROM accounts WHERE customer_id IN ${R}`,
    sql: `DELETE FROM accounts WHERE customer_id IN ${R}`,
    params: true,
  },
  {
    label: "address_history",
    count: `SELECT count(*)::int AS n FROM address_history WHERE user_id IN ${R}`,
    sql: `DELETE FROM address_history WHERE user_id IN ${R}`,
    params: true,
  },
  {
    label: "address_pool_unassign",
    count: `SELECT count(*)::int AS n FROM address_pool WHERE user_id IN ${R}`,
    sql: `UPDATE address_pool SET user_id = NULL, status = CASE WHEN status = 'assigned' THEN 'available' ELSE status END, updated_at = now() WHERE user_id IN ${R}`,
    params: true,
  },
  {
    label: "announcements",
    count: `SELECT count(*)::int AS n FROM announcements WHERE id = ANY($$ANN) OR title = ANY($$TITLES)`,
    sql: `DELETE FROM announcements WHERE id = ANY($$ANN) OR title = ANY($$TITLES)`,
    params: true,
  },
  {
    label: "campaigns",
    count: `SELECT count(*)::int AS n FROM campaigns WHERE id = ANY($$CAMP)`,
    sql: `DELETE FROM campaigns WHERE id = ANY($$CAMP)`,
    params: true,
  },
  {
    label: "help_articles",
    count: `SELECT count(*)::int AS n FROM help_articles WHERE id = ANY($$HELP)`,
    sql: `DELETE FROM help_articles WHERE id = ANY($$HELP)`,
    params: true,
  },
];

const tail: Step[] = [
  { label: "null_referred_by", count: `SELECT count(*)::int AS n FROM users WHERE referred_by IN ${R}`, sql: `UPDATE users SET referred_by = NULL WHERE referred_by IN ${R}`, params: true },
  { label: "null_account_manager", count: `SELECT count(*)::int AS n FROM users WHERE account_manager_id IN ${R}`, sql: `UPDATE users SET account_manager_id = NULL WHERE account_manager_id IN ${R}`, params: true },
  { label: "kyc_profiles", count: `SELECT count(*)::int AS n FROM kyc_profiles WHERE user_id IN ${R}`, sql: `DELETE FROM kyc_profiles WHERE user_id IN ${R}`, params: true },
  { label: "geo_alerts", count: `SELECT count(*)::int AS n FROM geo_alerts WHERE user_id IN ${R}`, sql: `DELETE FROM geo_alerts WHERE user_id IN ${R}`, params: true },
  { label: "activity", count: `SELECT count(*)::int AS n FROM activity WHERE user_id IN ${R}`, sql: `DELETE FROM activity WHERE user_id IN ${R}`, params: true },
  { label: "agent_tasks", count: `SELECT count(*)::int AS n FROM agent_tasks WHERE user_id IN ${R}`, sql: `DELETE FROM agent_tasks WHERE user_id IN ${R}`, params: true },
  { label: "null_agent_assignee", count: `SELECT count(*)::int AS n FROM agent_tasks WHERE assignee_id IN ${R}`, sql: `UPDATE agent_tasks SET assignee_id = NULL WHERE assignee_id IN ${R}`, params: true },
  { label: "api_keys", count: `SELECT count(*)::int AS n FROM api_keys WHERE user_id IN ${R}`, sql: `DELETE FROM api_keys WHERE user_id IN ${R}`, params: true },
  { label: "sessions", count: `SELECT count(*)::int AS n FROM sessions WHERE user_id IN ${R}`, sql: `DELETE FROM sessions WHERE user_id IN ${R}`, params: true },
  { label: "login_events", count: `SELECT count(*)::int AS n FROM login_events WHERE user_id IN ${R}`, sql: `DELETE FROM login_events WHERE user_id IN ${R}`, params: true },
  { label: "notification_prefs", count: `SELECT count(*)::int AS n FROM notification_prefs WHERE user_id IN ${R}`, sql: `DELETE FROM notification_prefs WHERE user_id IN ${R}`, params: true },
  { label: "notification_outbox", count: `SELECT count(*)::int AS n FROM notification_outbox WHERE user_id IN ${R}`, sql: `DELETE FROM notification_outbox WHERE user_id IN ${R}`, params: true },
  { label: "crypto_transfers", count: `SELECT count(*)::int AS n FROM crypto_transfers WHERE user_id IN ${R}`, sql: `DELETE FROM crypto_transfers WHERE user_id IN ${R}`, params: true },
  { label: "rail_transfers", count: `SELECT count(*)::int AS n FROM rail_transfers WHERE user_id IN ${R}`, sql: `DELETE FROM rail_transfers WHERE user_id IN ${R}`, params: true },
  { label: "redemptions", count: `SELECT count(*)::int AS n FROM redemptions WHERE user_id IN ${R}`, sql: `DELETE FROM redemptions WHERE user_id IN ${R}`, params: true },
  { label: "deposit_profiles", count: `SELECT count(*)::int AS n FROM deposit_profiles WHERE user_id IN ${R}`, sql: `DELETE FROM deposit_profiles WHERE user_id IN ${R}`, params: true },
  { label: "deposit_records", count: `SELECT count(*)::int AS n FROM deposit_records WHERE user_id IN ${R}`, sql: `DELETE FROM deposit_records WHERE user_id IN ${R}`, params: true },
  { label: "price_alerts", count: `SELECT count(*)::int AS n FROM price_alerts WHERE user_id IN ${R}`, sql: `DELETE FROM price_alerts WHERE user_id IN ${R}`, params: true },
  { label: "user_notices", count: `SELECT count(*)::int AS n FROM user_notices WHERE user_id IN ${R}`, sql: `DELETE FROM user_notices WHERE user_id IN ${R}`, params: true },
  { label: "watchlist", count: `SELECT count(*)::int AS n FROM watchlist WHERE user_id IN ${R}`, sql: `DELETE FROM watchlist WHERE user_id IN ${R}`, params: true },
  { label: "withdrawal_addresses", count: `SELECT count(*)::int AS n FROM withdrawal_addresses WHERE user_id IN ${R}`, sql: `DELETE FROM withdrawal_addresses WHERE user_id IN ${R}`, params: true },
  { label: "security_events", count: `SELECT count(*)::int AS n FROM security_events WHERE user_id IN ${R}`, sql: `DELETE FROM security_events WHERE user_id IN ${R}`, params: true },
  { label: "totp_lockouts", count: `SELECT count(*)::int AS n FROM totp_lockouts WHERE user_id IN ${R}`, sql: `DELETE FROM totp_lockouts WHERE user_id IN ${R}`, params: true },
  { label: "change_requests", count: `SELECT count(*)::int AS n FROM change_requests WHERE maker_id IN ${R}`, sql: `DELETE FROM change_requests WHERE maker_id IN ${R}`, params: true },
  { label: "null_checker", count: `SELECT count(*)::int AS n FROM change_requests WHERE checker_id IN ${R}`, sql: `UPDATE change_requests SET checker_id = NULL WHERE checker_id IN ${R}`, params: true },
  { label: "null_case_assignee", count: `SELECT count(*)::int AS n FROM risk_cases WHERE assignee_id IN ${R}`, sql: `UPDATE risk_cases SET assignee_id = NULL WHERE assignee_id IN ${R}`, params: true },
  { label: "null_ticket_assignee", count: `SELECT count(*)::int AS n FROM tickets WHERE assignee_id IN ${R}`, sql: `UPDATE tickets SET assignee_id = NULL WHERE assignee_id IN ${R}`, params: true },
  { label: "null_withdrawal_actor", count: `SELECT count(*)::int AS n FROM withdrawal_requests WHERE actor_id IN ${R}`, sql: `UPDATE withdrawal_requests SET actor_id = NULL WHERE actor_id IN ${R}`, params: true },
  {
    label: "reassign_deposit_actor",
    count: `SELECT count(*)::int AS n FROM manual_deposits WHERE actor_id IN ${R}`,
    sql: `UPDATE manual_deposits SET actor_id = (SELECT id FROM users WHERE address_pool_owner) WHERE actor_id IN ${R}`,
    params: true,
  },
  { label: "null_reverse_actor", count: `SELECT count(*)::int AS n FROM manual_deposits WHERE reverse_actor_id IN ${R}`, sql: `UPDATE manual_deposits SET reverse_actor_id = NULL WHERE reverse_actor_id IN ${R}`, params: true },
  { label: "null_content_overrides", count: `SELECT count(*)::int AS n FROM content_overrides WHERE updated_by IN ${R}`, sql: `UPDATE content_overrides SET updated_by = NULL WHERE updated_by IN ${R}`, params: true },
  { label: "null_content_audit", count: `SELECT count(*)::int AS n FROM content_audit WHERE actor_id IN ${R}`, sql: `UPDATE content_audit SET actor_id = NULL WHERE actor_id IN ${R}`, params: true },
  { label: "null_business_params", count: `SELECT count(*)::int AS n FROM business_params WHERE updated_by IN ${R}`, sql: `UPDATE business_params SET updated_by = NULL WHERE updated_by IN ${R}`, params: true },
  { label: "users", count: `SELECT count(*)::int AS n FROM users WHERE id IN ${R}`, sql: `DELETE FROM users WHERE id IN ${R}`, params: true },
];

function bind(sql: string): { text: string; params: unknown[] } {
  const usesRemoval = sql.includes("$1");
  const extra: unknown[] = [];
  let text = sql;
  const swap = (token: string, value: unknown) => {
    if (!text.includes(token)) return;
    extra.push(value);
    const index = extra.length + (usesRemoval ? 1 : 0);
    text = text.replaceAll(token, () => `$${index}`);
  };
  swap("$$CASES", SEED_CONTENT.cases);
  swap("$$TASKS", SEED_CONTENT.tasks);
  swap("$$ANN", SEED_CONTENT.announcements);
  swap("$$TITLES", SEED_CONTENT.announcementTitles);
  swap("$$CAMP", SEED_CONTENT.campaigns);
  swap("$$HELP", SEED_CONTENT.help);
  return { text, params: usesRemoval ? [REMOVAL_EMAILS, ...extra] : extra };
}

function parseArgs(argv: string[]): { confirm: boolean; totp: string } {
  let confirm = false;
  let totp = "";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") continue;
    if (arg === "--confirm") {
      confirm = true;
      continue;
    }
    if (arg === "--totp") {
      totp = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--totp=")) {
      totp = arg.slice("--totp=".length);
      continue;
    }
    throw new Error(`unknown argument ${arg}`);
  }
  return { confirm, totp };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const gateway = findGateway();
  const pool = openPool(databaseUrl(gateway));
  try {
    const fk = await pool.query<{ tbl: string; col: string }>(
      `SELECT cl.relname AS tbl, att.attname AS col
       FROM pg_constraint c
       JOIN pg_class cl ON cl.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = cl.relnamespace
       JOIN LATERAL unnest(c.conkey) AS cols(attnum) ON true
       JOIN pg_attribute att ON att.attrelid = cl.oid AND att.attnum = cols.attnum
       WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass AND n.nspname = 'public'
       ORDER BY 1, 2`,
    );
    const live = fk.rows.map((row) => `${row.tbl}.${row.col}`);
    const missing = live.filter((name) => !HANDLED.has(name));
    const stale = [...HANDLED].filter((name) => !live.includes(name));
    if (missing.length || stale.length) {
      console.error(`prelaunch-reset schema drift. unhandled: ${missing.join(", ") || "none"}. stale: ${stale.join(", ") || "none"}`);
      process.exit(1);
    }

    const owners = await pool.query<{ id: string; email: string; totp_secret: string }>(
      `SELECT id, email, totp_secret FROM users WHERE address_pool_owner`,
    );
    if (owners.rows.length !== 1) {
      console.error(`prelaunch-reset expected one pool owner, found ${owners.rows.length}`);
      process.exit(1);
    }
    const owner = owners.rows[0];
    const people = await pool.query<{ email: string; role: string }>(
      `SELECT email, role FROM users WHERE id IN ${R} ORDER BY email`,
      [REMOVAL_EMAILS],
    );
    const keptUsers = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE id NOT IN ${R}`,
      [REMOVAL_EMAILS],
    );
    const keptPool = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM address_pool`);
    const keptOverrides = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM content_overrides`);
    const keptParams = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM business_params`);
    const shared = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM journal_entries e
       WHERE EXISTS (
         SELECT 1 FROM postings p JOIN accounts a ON a.id = p.account_id
         WHERE p.entry_id = e.id AND a.customer_id IN ${R}
       ) AND EXISTS (
         SELECT 1 FROM postings p JOIN accounts a ON a.id = p.account_id
         WHERE p.entry_id = e.id AND a.customer_id = $2
       )`,
      [REMOVAL_EMAILS, owner.id],
    );
    const oneSided = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM trades
       WHERE (buyer_id IN ${R}) <> (seller_id IN ${R})`,
      [REMOVAL_EMAILS],
    );

    console.log(args.confirm ? "prelaunch-reset confirm requested" : "prelaunch-reset dry-run");
    console.log(`keep owner ${owner.email}`);
    console.log(`keep users besides the removal set: ${keptUsers.rows[0].n}`);
    console.log(`keep address_pool rows: ${keptPool.rows[0].n} (assignments to removed users would be released)`);
    console.log(`keep content_overrides: ${keptOverrides.rows[0].n}`);
    console.log(`keep business_params: ${keptParams.rows[0].n}`);
    console.log("play-money and paper rows would be cleared for every account, including the owner");
    console.log(`would remove ${people.rows.length} users`);
    for (const person of people.rows) console.log(`  remove ${person.role} ${person.email}`);
    for (const step of [...steps, ...tail]) {
      const bound = bind(step.count);
      const row = await pool.query<{ n: number }>(bound.text, bound.params);
      const n = Number(row.rows[0].n);
      if (n > 0) console.log(`would change ${step.label}: ${n}`);
    }
    console.log(`shared ledger entries with the owner: ${shared.rows[0].n}`);
    console.log(`trades with only one side in the removal set: ${oneSided.rows[0].n}`);
    const seeding = !gateway || (gateway.env.SEED_DEMO ?? "1") !== "0" || (gateway.env.BOTS ?? "1") !== "0";
    if (seeding) {
      console.log("confirm refused while SEED_DEMO or BOTS is on, or the gateway process cannot be read. Set both to 0 and restart before a real reset, or the seed returns.");
    }

    if (!args.confirm) {
      console.log("dry-run only. no dump, no delete. pass --confirm --totp <owner code> to apply.");
      return;
    }
    if (!/^\d{6}$/.test(args.totp)) {
      console.error("refusing: --confirm requires --totp and a current 6-digit owner code");
      process.exit(2);
    }
    if (seeding) {
      console.error("refusing: seeding is still on. no dump and no delete.");
      process.exit(2);
    }
    if (!verifyTotp(owner.totp_secret, args.totp)) {
      console.error("refusing: owner TOTP did not verify. lockout counter was not changed.");
      process.exit(2);
    }
    if (Number(shared.rows[0].n) > 0 || Number(oneSided.rows[0].n) > 0) {
      console.error("refusing: ledger or trades still join the owner to a removed account. no delete.");
      process.exit(2);
    }

    execFileSync(path.join(root, "scripts/backup-db.sh"), { stdio: "inherit" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const step of [...steps, ...tail]) {
        const bound = bind(step.sql);
        const result = await client.query(bound.text, bound.params);
        console.log(`applied ${step.label}: ${result.rowCount}`);
      }
      await client.query(
        `UPDATE balances b SET amount = COALESCE((
           SELECT SUM(CASE
             WHEN (a.account_type = 'asset' AND p.side = 'debit')
               OR (a.account_type = 'liability' AND p.side = 'credit')
             THEN p.amount ELSE -p.amount END)
           FROM postings p JOIN accounts a ON a.id = p.account_id
           WHERE p.account_id = b.account_id
         ), 0)`,
      );
      const still = await client.query<{ email: string }>(`SELECT email FROM users WHERE address_pool_owner`);
      const poolLeft = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM address_pool`);
      const overridesLeft = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM content_overrides`);
      if (still.rows[0]?.email !== owner.email) throw new Error("owner row missing after reset");
      if (Number(poolLeft.rows[0].n) !== Number(keptPool.rows[0].n)) throw new Error("address pool row count changed");
      if (Number(overridesLeft.rows[0].n) !== Number(keptOverrides.rows[0].n)) throw new Error("content override count changed");
      await client.query("COMMIT");
      console.log("prelaunch-reset committed");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
