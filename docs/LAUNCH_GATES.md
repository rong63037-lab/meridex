# Launch gates

This is the go-live list for 上架. It maps to the jurisdiction rules in `docs/jurisdiction-policy-v0.md`, the recovery targets in `docs/critical-systems.md`, and the machine check in `scripts/prelaunch-check`. It is not a licence, not legal advice, and not a statement that any gate has been passed.

Status below is the local sandbox on 25 October 2026. `scripts/prelaunch-check` is the repeatable part. Re-run it after each change. Real customer funds stay off until every blocker is met.

## Standing rule

Leverage, perpetual futures, and copy trading stay off until the owner turns that product on. The switch lives in Content & parameters, needs the owner's authenticator code, and is audited. On posts to an internal book and the customer's margin or derivatives wallet. That book is not an external liquidity provider, and a passing sandbox order is not a licence. Off is coming-soon when there is nothing to reduce, and reduce-only when a position or wallet balance remains. Simulation stays on the paper ledger. Do not take outside customer funds into these products until the licence gate below is actually met.

## Blockers before real customer funds

| Gate | Where it lives | Sandbox status | What must be true |
|---|---|---|---|
| MAS licence | Product copy says the Singapore application is in progress. Nothing in git grants a licence | Not met | The owner has the licence (or the written exemption) that covers the products actually offered, and the public copy matches that scope |
| KYC/AML vendor | `decideKyc` in the gateway is an in-process policy | Not met | A licensed vendor does identity and sanctions screening. A sanctions hit still refuses with `SANCTIONS_HIT`. Nationality alone still does not refuse |
| Terms, privacy, risk disclosures | The site shows a licence-in-progress line and risk warnings | Not met | Counsel-approved terms, privacy notice, and risk disclosures are published. In-product warnings are not that pack |
| Geo-blocking and jurisdiction switches | `docs/jurisdiction-policy-v0.md`, tables `jurisdiction_access`, `category_access`, `mode_access` | Not met for production | Switches match the policy. US leverage and perps still return `US_RETAIL_BLOCK` even if a cell is edited to allow. DPRK, Iran, and Syria stay locked. Crypto stays closed for CN, BD, NP, QA, KW, OM, IQ, AF. Production geo is not the `X-Mock-Country` header; `SANDBOX_MOCK_GEO` must be `0` and the mock file must not be the source |
| Incident response | `docs/critical-systems.md` records design RPO/RTO, not a drill | Not met | Named on-call, a customer-notice path, and one timed restore of the database and the matching engine journal. The design targets (engine restart, four-hour regulatory floor, five-year audit retention) are goals, not measured results |
| Custody / wallet integration | Address desk stores imported strings | Not met | A real custodian or a documented wallet process the owner has accepted. The app still does not derive keys |
| Deposit detection | Manual credits and simulated deposits | Not met | A real detector the owner has reconciled against the ledger. Staff manual credit is not that detector |
| Bank rails | Simulated bank | Not met | A real settlement path, or fiat stays disabled |
| Secrets only from the environment | Check `repo_secrets`, `env_sandbox_secrets`, `sandbox_code_defaults` | Not met | No published password, TOTP seed, sandbox JWT, or sandbox database URL in the tree or the process. Code defaults that turn seeding on are gone |
| Owner credentials rotated | Check `owner_credentials_rotated` | Not met | The pool owner's password and TOTP are no longer the published sandbox pair. Other staff use their own secrets, not the seeded ones |
| Seed and test population gone | Check `internal_test_excluded`, `demo_seed_data`. Reset: `scripts/prelaunch-reset` | Not met | Seed customers, bots, audit accounts, play and paper ledgers, sample orders, and seed announcements, campaigns, and help articles are gone. Public stats exclude `is_internal_test`, but the seeded customers are not flagged, so they count today |
| Address pool verified by the owner | Check `address_pool_verified` | Not met | Every sandbox-generated address is gone, the owner imported the replacements, and `MERIDEX_POOL_VERIFIED=1` |
| Fees and limits reviewed | Check `params_reviewed`. Screen is Content & parameters | Not met | The owner has reviewed maker/taker, convert, deposit, withdrawal, and redemption figures, stored the ones that should differ from code defaults, and set `MERIDEX_PARAMS_REVIEWED=1` |
| Cookies, CORS, admin network | Checks `cookie_secure`, `cors_and_origin`, `admin_ip_allowlist`, `tls_public_urls` | Not met | `Secure` on session cookies, an explicit origin list, HTTPS public URLs, and an IP allow-list plus VPN for admin and the address desk. `HttpOnly` and `SameSite=Lax` already pass |
| Backups and a tested restore | Checks `backup_dump`, `backup_schedule`, `backup_offsite`, `backup_restore_tested` | Dump only | A local dump exists. Nothing schedules it, nothing copies it offsite, and there is no `restore-tested.json` |
| Feeds | Check `feeds_healthy` on gateway `/healthz` | Not met | `feeds.ok` and no `lastError` on the quote feed or the candles. Candles currently report `binance unavailable` |
| Migrations | Check `migrations_current` | Met locally | Every file in `db/migrations` is in `schema_migrations`. Re-check on the production database after the first boot |
| Rate limits | Check `rate_limits` | Present, not tuned | Limits exist on register, login, withdraw, alerts, paper, orders, and the v1 API. The owner still has to accept the numbers for production |

## Jurisdiction switches that stay in force

From `docs/jurisdiction-policy-v0.md`:

- Residence unknown or missing → `JURISDICTION_CLOSED`.
- `pending` cannot trade. `block` returns `JURISDICTION_BLOCKED`.
- DPRK, Iran, and Syria return `JURISDICTION_LOCKED` and cannot be opened from the compliance screen.
- A sanctions hit returns `SANCTIONS_HIT`.
- Source country `block` is rejected and written as an alert. A mismatch with the KYC residence is allowed and written as an alert.
- Afghanistan and Myanmar stay high-risk (enhanced due diligence). Afghanistan crypto stays closed.
- Malaysia is booked on `MY-ENTITY`. Other allowed residences are booked on `SG-OPCO`.
- The sandbox source country comes from `X-Mock-Country` or `gateway/config/geoip-mock.json` while `SANDBOX_MOCK_GEO` is not `0`. That is not MaxMind and it is not a production control.

## What “accepted” means

Real customer funds are acceptable only when every blocker in the table is met, the check prints `result PASS`, and the owner has said so in writing. Until then the customer site stays on loopback, the copy keeps saying that no real funds and no real bank are connected, and leverage, perps, and copy trading stay simulated.
