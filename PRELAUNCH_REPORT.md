# Prelaunch report

Local sandbox only. Nothing was deployed, no domain was registered, and no service was purchased. The readiness check below is a no-go: **result FAIL, 7 pass, 19 fail**. Real customer funds stay off until `scripts/prelaunch-check` prints `result PASS` and the gates in `docs/LAUNCH_GATES.md` are met.

The check is read-only. `scripts/prelaunch-reset` was run as a dry-run and did not dump or delete. User count stayed at 31.

## Check output

Run from the repo root against the live gateway (pid 26177) and the local database on 25 October 2026. Bot orders keep increasing while `BOTS=1`, so the order count is a snapshot.

```text
prelaunch-check  local sandbox  read-only  no deploy
FAIL  db_published_passwords     29 accounts still match a published sandbox password
FAIL  db_published_totp          20 accounts still store a published sandbox TOTP seed
PASS  owner_account_present      pool owner is founder@meridexexchange.com
FAIL  owner_credentials_rotated  owner password still matches; owner TOTP still matches
FAIL  internal_test_excluded     30 seed, bot, audit, or manual-test accounts remain; 0 are flagged is_internal_test. Public stats only skip that flag, so unmarked seed customers are still counted
FAIL  demo_seed_data             43 bot surveillance alerts; 149823 orders on seed accounts; 4 paper-trading rows; 3 seed announcements; 1 seed campaigns; 4 seed help articles
PASS  migrations_current         17 migrations applied, through 017_neutral_copy
FAIL  address_pool_verified      32 of 34 addresses match the sandbox generator; owner verification is not accepted while those remain
FAIL  params_reviewed            no owner sign-off. Stored params: deposit.feeUsd=0, deposit.flagUsd=10000, deposit.maxUsd=0, withdraw.reviewUsd=0. Fee table: gold 5/12 bps, private 2/8 bps, silver 8/16 bps, standard 10/20 bps. Code defaults still apply to every fee key that is not stored
FAIL  env_sandbox_secrets        gateway or process environment still carries the sandbox JWT, database password, or a published seed
FAIL  repo_secrets               20 files still contain a published password, TOTP seed, sandbox JWT, or sandbox database URL. Examples: .github/workflows/m1.yml, ACCOUNTS.md, README.md, RUN_LOCAL.md, docker-compose.yml, gateway/Dockerfile, gateway/scripts/ledger-stress.ts, gateway/src/platform.ts
FAIL  sandbox_code_defaults      JWT fallback in gateway code; database URL fallback; SEED_DEMO defaults on; mock geo defaults on; BOTS defaults on; start-meridex.sh injects sandbox defaults
FAIL  sandbox_flags              pid 26177: SEED_DEMO=1 BOTS=1 SANDBOX_MOCK_GEO=1
PASS  cookie_httponly            session cookies set HttpOnly
PASS  cookie_samesite            session cookies set SameSite=Lax or Strict
FAIL  cookie_secure              session cookies omit Secure. Leave it off while the sandbox is plain HTTP; set it only behind the TLS proxy
FAIL  cors_and_origin            CORS reflects any origin, and CSRF allows only localhost and 127.0.0.1. Production needs an explicit origin list for the customer, admin, and desk hosts
FAIL  admin_ip_allowlist         ADMIN_IP_ALLOWLIST is empty, so admin routes are not IP-restricted
PASS  rate_limits                rate limits exist on register, login, withdraw, alerts, paper, orders, and v1. The numbers are sandbox values, not a production tuning review
FAIL  tls_public_urls            CUSTOMER_PUBLIC_URL=unset ADMIN_PUBLIC_URL=unset POOL_PUBLIC_URL=unset. TLS is expected at the reverse proxy; these URLs are not https
PASS  loopback_bind              GATEWAY_HOST=127.0.0.1
PASS  backup_dump                local dump 2026-10-25T11:08:07Z 34188710 bytes
FAIL  backup_schedule            backup-db.sh is not scheduled. scripts/com.meridex.backup.plist is a template with /Users/YOU paths and is not installed
FAIL  backup_offsite             MERIDEX_BACKUP_OFFSITE is unset; dumps stay on this machine
FAIL  backup_restore_tested      no restore-tested.json from a scratch restore drill
FAIL  feeds_healthy              healthz ok=true halted=false feeds.ok=true lastError=none candles=local candles.lastError=binance unavailable
result FAIL  pass=7  fail=19
```

## What already holds

These passes are real and they are not a launch:

- One pool owner exists: `founder@meridexexchange.com`.
- All 17 migrations are applied, through `017_neutral_copy`.
- Session cookies are `HttpOnly` and `SameSite=Lax`.
- Rate limits exist on register, login, withdraw, alerts, paper, orders, and v1. They have not been reviewed for production traffic.
- The gateway listens on `127.0.0.1`.
- A local custom-format dump from 2026-10-25T11:08:07Z is on disk (about 34 MB). It is not scheduled, not offsite, and not signed off as a restore drill.

## What the owner has to do

Do these before any public hostname. The order is the one that avoids locking the sandbox you are still using.

1. Leave leverage, perps, and copy trading on the paper ledger. Do not take real customer funds. Licensing, a KYC vendor, terms, privacy, risk disclosures, production geo, incident response, custody, deposit detection, and bank rails are all open. See `docs/LAUNCH_GATES.md` and `docs/PRODUCTION.md`.
2. Rotate the owner password and the owner TOTP. Both still match the pair published for the sandbox. Put the new values in a secrets manager, not in git.
3. Replace the sandbox JWT and the database password. Remove the fallbacks in `gateway/src/server.ts`, `gateway/src/platformRoutes.ts`, and `start-meridex.sh`. The check currently finds those strings in 20 files, including `ACCOUNTS.md`, `README.md`, `RUN_LOCAL.md`, the workflow, Docker files, and tests.
4. Set `SEED_DEMO=0`, `BOTS=0`, and `SANDBOX_MOCK_GEO=0`, then restart the gateway. Until geo is a real source, country checks are not a production control. `docs/jurisdiction-policy-v0.md` still applies, including `US_RETAIL_BLOCK` and the locked sanctions jurisdictions.
5. Read `scripts/prelaunch-reset` with no flags. The dry-run would remove 30 seed, staff, bot, and audit accounts and keep the owner. It would release 12 pool assignments and keep all 34 pool rows, the 4 business parameters, and content overrides (there are none today). It would also clear paper wallets for every account, including the owner. Shared ledger entries with the owner: 0. Confirm is refused while seeding is on, and it was not run.
6. After seeding is off, and only when you are ready to wipe this sandbox, run `scripts/prelaunch-reset --confirm --totp <current owner code>`. It dumps first. A wrong code does not touch the lockout counter.
7. Replace the 32 sandbox-generated deposit addresses. Two of the 34 rows are already not from that generator. Set `MERIDEX_POOL_VERIFIED=1` only after none of the generated addresses remain.
8. Review fees and limits on Content & parameters. Stored today: deposit fee 0, deposit flag 10,000 USD, deposit max 0, withdrawal review 0 (every withdrawal waits). Fee table: standard 10/20, silver 8/16, gold 5/12, private 2/8 bps. Other fee keys still use code defaults. Set `MERIDEX_PARAMS_REVIEWED=1` only after that review.
9. Schedule `scripts/backup-db.sh`, set `MERIDEX_BACKUP_OFFSITE`, restore a dump into a scratch database, and write `restore-tested.json` as described in `docs/PRODUCTION.md`. The LaunchAgent plist is a template with `/Users/YOU` paths and is not installed here.
10. Put TLS on the reverse proxy, set the three public URLs to `https://`, add `Secure` to the session cookies at that point (not on this HTTP sandbox), replace reflect-any CORS with an explicit origin list, and set `ADMIN_IP_ALLOWLIST` plus a VPN for admin and the address desk.
11. Clear the candle error. `/healthz` is ok and the quote feed has no `lastError`, but candles report `binance unavailable`.
12. Re-run `scripts/prelaunch-check`. Launch stays blocked while any line is `FAIL`.

## Reset dry-run

`scripts/prelaunch-reset` exited 0. It printed the 30 accounts it would remove, the row counts it would change (including 149,586 seed orders and 298,034 ledger entries that belong only to those accounts), and this line:

```text
confirm refused while SEED_DEMO or BOTS is on, or the gateway process cannot be read. Set both to 0 and restart before a real reset, or the seed returns.
dry-run only. no dump, no delete. pass --confirm --totp <owner code> to apply.
```
