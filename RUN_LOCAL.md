# MERIDEX local run

This sandbox is not deployed. There is no public host, no Render blueprint, and no deploy hook. Use the branch you already have.

## Accounts

| Role | Email | Password | TOTP seed |
|---|---|---|---|
| Customer | `client@meridexexchange.com` | `<redacted>` | `<redacted>` |
| Compliance | `compliance@meridexexchange.com` | `<redacted>` | `<redacted>` |
| Super-admin / address-pool owner | `founder@meridexexchange.com` | `<redacted>` | `<redacted>` |
| Support | `support@meridexexchange.com` | `<redacted>` | `<redacted>` |
| Risk | `risk@meridexexchange.com` | `<redacted>` | `<redacted>` |
| Ops maker | `ops@meridexexchange.com` | `<redacted>` | `<redacted>` |
| Ops checker | `ops.checker@meridexexchange.com` | `<redacted>` | `<redacted>` |

Sign-in fields start empty. The banner, help, and other helper sentences are edited under Content & parameters. The owner seed is a sandbox value so the address pool can be exercised locally. Five wrong codes lock the owner for 15 minutes. Acceptance clears that lockout and puts the seeded BTC address back before it exits. A gateway restart with `SEED_DEMO=1` also restores the printed seed and clears a leftover lockout.

Accounts with role `admin` (the founder, and the optional compliance login) can propose a change and approve it themselves. The propose and the decision are written to `security_events`. Ops maker and ops checker still cannot approve their own change. The other staff logins stay in the seed and are optional for a one-person desk. See `ACCOUNTS.md` for which URL does what.

## Address pool

Deposit addresses are added by the owner on the address desk at http://127.0.0.1:4319. The page is one screen: a count of total, free, and assigned addresses, a low-stock line, and one Add addresses button. Paste one address per line. Bitcoin and TRON are detected from the address. An Ethereum address needs the network set to ETH or USDT. The page shows a count and a plain error on each bad line before Save. One authenticator code covers that whole paste. The list can be searched and filtered. An assigned row can be replaced (the customer is notified in the app and the owner is emailed; the old address stays for attribution). A free row can be removed. Threshold, spreadsheet paste (`asset,network,address`), stop, and manual assign stay under More, and each of those still needs its own fresh code. The main admin at 4318 can list the pool, masked for everyone except the owner, and cannot import, edit, retire, delete, assign, or change a threshold. Those writes return `POOL_DESK`. The address desk login is the owner account only. The server checks Bitcoin, EVM, and TRON checksums and rejects duplicates. It does not derive keys and it does not ask for an ownership signature. Other staff see masked addresses. Customers and the verified deposit card read only the assignment. An empty pool shows “address being prepared, contact support”. The desk copy is Chinese first, with English and Malay on the language menu.

## Content and parameters

The main admin has Content & parameters. Every bundled customer string (zh, en, ms, including desk, account, funds, concierge, and error text) can be searched, edited, previewed, and reset to the bundled default. Overrides live in `content_overrides` and the public `GET /api/content` response is cached for about two seconds. The customer site polls that route about every three seconds and paints the override without a rebuild. Trading fees, convert fee and spread, deposit and withdrawal fees and USD limits, redemption fees, and the home-page volume / market / place figures are editable numbers with a min and max. Out of range returns `VALIDATION`. Each string or number change writes `content_audit` with the old and new value. Announcements and the top banner are edited on the same page. A zero fee or a zero min/max means no extra charge and no extra limit. A zero home stat keeps the live counter. `deposit.flagUsd` is the manual-credit surveillance threshold (default 10,000 USD, 0 = do not flag). Deposit addresses are not in this editor.

## Manual deposits

Incoming transfers are not detected automatically. On 4318, Manual deposits / 手动入账 (nav: Credits) lets the super-admin or an ops login credit a customer. Search by email or id, then enter asset, network, amount, a required reference (txid or bank reference), and when it was received. The page shows that customer's deposit address and any pending "I have sent funds" claim, which can be filled in with one click. Review shows the customer, the gross amount, the deposit fee, and the net credit. Posting needs the current authenticator code. The reference is unique per asset, so the same txid cannot be credited twice. The credit is a normal double-entry deposit (`deposit_usd` or `vault_in`) and the journal reference contains the txid. Internal test accounts are rejected (`PLAY_ONLY`) and play-money tables are not touched. Limits and the USD fee come from Content & parameters. A net at or above `deposit.flagUsd` opens a surveillance alert. The customer gets an inbox notice. Past credits can be searched and exported as CSV. Only the super-admin can reverse one, with a fresh authenticator code and a reason, and only when the available balance still covers the net. The customer deposit page has a small "I have sent funds" form. That form files a claim. It does not credit, and support chat does not credit.

## Withdrawals

`withdraw.reviewUsd` in Content & parameters is the review threshold. The default is 0, so every withdrawal waits. An amount strictly below the threshold is posted the way it was before (an immediate ledger withdrawal on `/api/wallet/withdraw`, or the mock bank / chain workflow on the customer funds page). At or above the threshold the funds move from available to a withdrawal hold and the row stays `pending`. The super-admin approves or rejects it on 4318 (Withdrawals / 出金审核) with a fresh authenticator code. A rejection needs a reason and releases the hold. The customer gets an inbox notice either way. Internal test accounts are rejected with `PLAY_ONLY` and never touch the real ledger. A withdrawal at or above the surveillance large-withdrawal rule (20,000 USD) still opens an alert when it is requested.

## Deposit reconciliation

Credits → Reconciliation (`/deposits/reconcile`) is one list. Today shows claims and manual credits created since midnight in the database timezone. Claims and Credits show those lists on their own. Unmatched keeps every claim that is still pending, including yesterday's, plus today's credits that were not tied to a claim. CSV exports the filter that is on screen.

## Backups

`scripts/backup-db.sh` runs `pg_dump -Fc --no-owner` into `~/meridex/backups/meridex-YYYYMMDD-HHMMSS.dump`, appends `backup.log`, writes `latest.json`, and keeps the newest 7 dumps. The admin home reads that file.

macOS, once a day at 03:15, after replacing `/Users/YOU` with the home directory that holds the script:

```bash
mkdir -p ~/meridex/backups ~/Library/LaunchAgents
cp scripts/com.meridex.backup.plist ~/Library/LaunchAgents/
# edit the two /Users/YOU paths inside the plist
launchctl load ~/Library/LaunchAgents/com.meridex.backup.plist
```

cron on the same clock:

```cron
15 3 * * * /bin/sh /path/to/scripts/backup-db.sh
```

Restore into a scratch database:

```bash
sudo -n -u postgres createdb -O meridex meridex_restore
pg_restore --no-owner --dbname "postgres://meridex:<redacted>@127.0.0.1:5432/meridex_restore" ~/meridex/backups/meridex-YYYYMMDD-HHMMSS.dump
psql "postgres://meridex:<redacted>@127.0.0.1:5432/meridex_restore" -c "SELECT count(*) FROM users"
sudo -n -u postgres dropdb meridex_restore
```

## To do today

The admin home lists pending deposit claims, pending withdrawals, pending KYC, unanswered support chats, feed problems, and the last backup. Each row links to its page. Feed problems and the backup status stay on the home.

## Deposit concierge

## Deposit concierge

Funds is split into Overview, Deposit, Withdraw, and History. Deposit is one asset and one network at a time. A verified card opens `/funds/deposit` with that asset and network already selected. Callback booking sits in the support chat. Support can send a verified address card (the server fills the address) or look up a deposit. Customer messages are never blocked. Staff messages are blocked only when they contain a bank account or crypto address that is not already linked to that customer.

The account page is a header (masked email, UID, KYC, VIP) and a short menu. Password, authenticator, anti-phishing code, devices, and the withdrawal whitelist live on Security. Language, currency, notifications, and price alerts live on Preferences. Invite codes, API keys, and support each have their own page. Rewards, inbox, developer notes, and help sit under More. Role, entity, and the equity curve stay behind paper trading.

The trade page opens on buy and sell. Advanced brings back the market list, order book, stop and OCO orders, and time-in-force. The choice is stored in `meridex.advanced`. A first visit still opens Advanced so the tour can point at the book. Switching simple and advanced does not change the selected instrument. Spot, convert, and recurring stay on the trade routes. Margin, perpetuals, and copy stay there too, marked Demo. `GET /healthz` includes `feeds` (price sources and whether candles came from Binance or the local history). A dropped market-maker socket or a candle `ECONNRESET` retries, then keeps the local book and local candles.

A markets row, a watchlist card, and the home tape open `/terminal?symbol=BTC%2FUSD` (the slash is encoded). The query string wins over `meridex.symbol` in localStorage. That stored value is used only when the URL has no symbol, and `XAU/USD` is used only when both are empty. Ticker polling and the three-second content poll do not write the symbol back. The star and the “add XAU, XAG, BTC, ETH” button change the watchlist only. Search, category, and sort keep each row tied to its own symbol, including `XAUKG/USD` and `BTC/USD`.

## Staff test accounts

On 4318, Internal test is limited to the super-admin. Staff practice logins are flagged `is_internal_test`, badged `INTERNAL TEST / 内部测试`, and funded only with play money. They sign in on 4317. Optional TOTP can be left off. Deposits, withdrawals, convert, and paper trading return `PLAY_ONLY`. Their orders fill in `play_orders` at the live reference price and never reach the matching engine or the customer reports. A reason is required on every credit and debit. Disable and delete are on the same page. See `ACCOUNTS.md`.

## Database

Create a clean role and database. Do not point the gateway at an older database.

```bash
sudo -u postgres psql -c "CREATE USER meridex WITH PASSWORD 'meridex' SUPERUSER;"
sudo -u postgres psql -c "CREATE DATABASE meridex OWNER meridex;"
sudo -u postgres psql -c "CREATE DATABASE meridex_test OWNER meridex;"
```

## Processes

```bash
cargo build --manifest-path engine/Cargo.toml
cd gateway && npm install

mkdir -p data
ENGINE_BIND=0.0.0.0:7109 ENGINE_JOURNAL=data/engine-journal.jsonl \
  ENGINE_REF_PRICE=13000 ENGINE_BAND_BPS=500 ENGINE_HALT_BPS=200 ENGINE_FSYNC_EVERY=25 \
  ./engine/target/debug/meridex-engine serve

cd gateway
DATABASE_URL=postgres://meridex:<redacted>@127.0.0.1:5432/meridex \
ENGINE_URL=http://127.0.0.1:7109 GATEWAY_PORT=7108 \
JWT_SECRET=<redacted> \
SEED_DEMO=1 BOTS=1 SANDBOX_MOCK_GEO=1 \
npx tsx src/index.ts

cd web && npm run build && API_INTERNAL_URL=http://127.0.0.1:7108 PORT=4317 node server.mjs
cd web-admin && npm install && npm run build && API_INTERNAL_URL=http://127.0.0.1:7108 PORT=4318 node server.mjs
cd web-pool && npm install && npm run build && API_INTERNAL_URL=http://127.0.0.1:7108 PORT=4319 node server.mjs
```

`./start-meridex.sh` (and `./start-local.sh`, which calls it) clears a stale Postgres `postmaster.pid` only when that pid is not a running postgres process, waits until `pg_isready` accepts `meridex`, then starts whichever of 7109, 7108, 4317, 4318, and 4319 is not already listening. It does not stop them. `./start-meridex.sh --check-pid <pgdata>` only runs the pid check.

Customer site, admin, the address desk, and gateway listen on `127.0.0.1` unless `HOST`, `ADMIN_HOST`, `POOL_HOST`, or `GATEWAY_HOST` is set. Use `0.0.0.0` for those variables when a container must accept traffic from outside its own network namespace.

Customer site: http://127.0.0.1:4317  
Admin (everything except address writes, plus Content & parameters): http://127.0.0.1:4318  
Address desk (owner login, TOTP on every change): http://127.0.0.1:4319

## Checks

```bash
cd gateway && npx tsx src/totp.test.ts && npx tsx src/addresses.test.ts && npx tsx src/pool.db.test.ts
cd gateway && npx tsx ../tests/acceptance/run.ts
cd gateway && ORDERS=500 npx tsx scripts/ledger-stress.ts
cargo test --manifest-path engine/Cargo.toml -- --test-threads=8
```

`pool.db.test.ts` checks an empty-pool message, a two-way assignment race, and that the audit table rejects updates.
