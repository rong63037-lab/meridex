# Production shape (preparation only)

This is the 上架前 topology for a Singapore launch. Nothing in this repository has been deployed, no domain has been registered, and no cloud account has been opened. The running system is the local sandbox on `127.0.0.1`. Leave it that way until the owner decides otherwise and `scripts/prelaunch-check` prints `result PASS`.

## What is not real yet

These parts of the sandbox must not be described as production, and they must not take real customer funds:

| Piece | What the sandbox actually does |
|---|---|
| Custody / wallet | Deposit addresses are strings the owner imports. The server does not hold keys, does not derive them, and does not talk to a custodian. |
| Deposit detection | There is no chain watcher. Credits are manual staff entries or simulated rails. |
| Bank rails | Fiat deposits and withdrawals are simulated. There is no bank, no payment network, and no settlement account. |
| KYC/AML vendor | `decideKyc` is an in-process policy. It is not a licensed screening vendor. |
| Licensing | The product says a Singapore licence application is in progress. No licence is granted by this repository. |

Leverage, perpetual futures, and copy trading are off by default. The owner can turn each one on from Content & parameters; that save needs the owner's authenticator code and is audited. On means verified customers trade an internal book against their own margin or derivatives wallet. It is not an external market maker, and it is not evidence that a licence covers the product. Off refuses new risk (`LIVE_OFF`) and still allows closes and transfers back to spot. Simulation stays on a separate paper ledger. Do not treat the switch as permission to take outside customer funds.

## Recommended topology

Run this in a Singapore region. One availability zone is enough for a first cut; the database should still be a managed service with its own backups.

```text
Internet
  │
  ├─ customer.example  443  WAF → TLS reverse proxy → customer site on 127.0.0.1
  │
  ├─ admin.example     443  VPN + IP allow-list → TLS proxy → admin site on 127.0.0.1
  │
  └─ desk.example      443  VPN + IP allow-list → TLS proxy → address desk on 127.0.0.1

Private network only
  gateway  127.0.0.1:7108
  engine   127.0.0.1:7109   (one client: the gateway)
  Postgres managed, TLS, not reachable from the internet
```

Use three hostnames. The customer site is the only one on the public internet. Admin and the address desk should not have a public DNS record that answers for the whole internet; put them behind a VPN and set `ADMIN_IP_ALLOWLIST` to the VPN egress addresses. The desk uses the same restriction at the proxy (the gateway allow-list today covers `/api/admin` only).

On the hosts:

- TLS terminates at the reverse proxy. The Node sites and the gateway keep binding to `127.0.0.1`.
- A WAF sits in front of the customer hostname (rate, bot, and geo rules). It does not replace the jurisdiction switches in the app.
- Ship proxy access logs, gateway logs, and engine logs off the box the same day. Keep them at least as long as the audit retention in `docs/critical-systems.md` (design target: five years once a WORM store exists; the sandbox does not have one).
- Alert on gateway `/healthz` (including `feeds.candles.lastError`), 5xx rate, disk, backup age, and a failed dump.
- Daily `pg_dump` plus a copy of the engine journal from the same minute. The copy goes offsite. Seven local files is not an offsite backup.
- Secrets live in a secrets manager and are injected into the process environment. They are not in git, not in the image, and not in a default in code.

Managed Postgres should require TLS and should not use the sandbox role password.

## Environment

`scripts/prelaunch-check` reads the live gateway environment. A value of “sandbox default” is a failure.

| Variable | Sandbox today | Before real traffic |
|---|---|---|
| `DATABASE_URL` | local URL in `start-meridex.sh` and `gateway/src/server.ts` (same word for user and password) | Managed Postgres URL from the secrets manager, TLS on |
| `JWT_SECRET` | compiled fallback and the start-script default | Random secret from the secrets manager. Remove the code fallback |
| `ENGINE_URL` | `http://127.0.0.1:7109` | Private URL. Do not publish it |
| `GATEWAY_HOST` / `GATEWAY_PORT` | `127.0.0.1` / `7108` | Stay on loopback behind the proxy |
| `HOST` / `ADMIN_HOST` / `POOL_HOST` | `127.0.0.1` | Stay on loopback |
| `SEED_DEMO` | `1` (also the code default) | `0` |
| `BOTS` | `1` (also the code default) | `0` |
| `SANDBOX_MOCK_GEO` | `1` (mock header is honored unless this is `0`) | `0`, and replace the mock map with a real GeoIP source. That source is not in this tree |
| `ADMIN_IP_ALLOWLIST` | empty | VPN egress IPs, comma-separated |
| `CUSTOMER_PUBLIC_URL` | unset; code mentions `http://127.0.0.1:4317` | `https://` customer hostname |
| `ADMIN_PUBLIC_URL` | unset; code mentions `http://127.0.0.1:4318` | `https://` admin hostname |
| `POOL_PUBLIC_URL` | unset; the gateway does not read it yet | `https://` desk hostname. The check requires it anyway |
| `API_INTERNAL_URL` | `http://127.0.0.1:7108` | Private gateway URL used by the three sites |
| `MERIDEX_BACKUP_DIR` | `~/meridex/backups` | Local spool directory |
| `MERIDEX_BACKUP_OFFSITE` | unset | Destination the daily job copies to (object store or another region) |
| `MERIDEX_POOL_VERIFIED` | unset | `1` only after the owner has replaced every sandbox-generated address |
| `MERIDEX_PARAMS_REVIEWED` | unset | `1` only after the owner has reviewed fees and limits |
| `ENGINE_BIND` | `127.0.0.1:7109` | Loopback |
| `ENGINE_JOURNAL` | `data/engine-journal.jsonl` | Persistent disk, copied with the database dump |
| `ENGINE_FSYNC_EVERY` | `25` | Keep a bounded fsync; do not turn it off |

Session cookies are `HttpOnly` and `SameSite=Lax`. They do not set `Secure`. Add `Secure` only when the browser reaches the site over HTTPS. Adding it on this HTTP sandbox breaks local login.

There is no `COOKIE_SECURE` switch in the code today. The check fails `cookie_secure` until the three session cookies send `Secure`.

A restore drill writes `~/meridex/backups/restore-tested.json`:

```json
{"ok": true, "at": "2026-10-25T00:00:00Z", "file": "/absolute/path/to/the.dump", "note": "restored into a scratch database"}
```

The check does not create that file and does not treat an old local dump as a drill.

## Rollback

Do this before any change that has already been taken to a real host. Do not aim DNS at the new build until `docs/LAUNCH_GATES.md` is satisfied.

1. Take a custom-format dump with `scripts/backup-db.sh` and copy it offsite. Copy `ENGINE_JOURNAL` from the same minute. Record the git revision of the build that is about to be replaced.
2. To roll back an application change: stop the gateway, start the previous build with the same database, and read `GET /healthz` on the gateway. Do not probe the engine port yourself; the gateway holds its one connection.
3. To roll back a bad migration or a bad ledger write: stop the gateway and the engine, restore that dump into a new database with `pg_restore --no-owner`, point `DATABASE_URL` at it, and restore the matching engine journal. Do not replay a new journal on an old database, or the reverse.
4. Leave DNS on the last known-good host until `/healthz` is ok, a staff login works, and the owner can see the address pool.
5. `scripts/prelaunch-reset` is not a rollback. It deletes sandbox customers. It refuses to run while `SEED_DEMO` or `BOTS` is on, it takes its own dump first, and it keeps the owner, content overrides, business parameters, and the address-pool rows.

## Local operation

The local scripts stay:

```text
./scripts/prelaunch-check
./scripts/prelaunch-reset
./scripts/prelaunch-reset --confirm --totp 123456
```

The reset is a dry-run unless both `--confirm` and a current owner TOTP are present. A wrong code is checked in the script and does not increment the desk lockout. Do not run `--confirm` against the sandbox you still use for day-to-day testing.
