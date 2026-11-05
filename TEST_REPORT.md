# MERIDEX global test

Local sandbox only. Customer http://127.0.0.1:4317, admin http://127.0.0.1:4318, address desk http://127.0.0.1:4319, gateway http://127.0.0.1:7108, engine http://127.0.0.1:7109, Postgres on 127.0.0.1:5432.

Latest scripted pass: `make test` (engine matching 13, gateway TOTP and address vectors, quantity and simulation guards, acceptance `ACCEPTANCE_OK`, ledger invariants 64/64, `tests/live-products.test.ts`, `tests/funds-desk.test.ts`, `tests/liquidity.test.ts`, `tests/simple-math.test.ts`, `tests/chart-perf.test.ts`, `tests/reference-depth.test.ts`, `tests/lp-adapters.test.ts`, `tests/fees.test.ts`, `tests/pair-nav.test.ts`). Chart history in that pass: 300 bars, 53 ms cold / 28 ms warm, WebSocket 9,059 bytes, engine 0 ms, transit 2 ms. `tests/simple-ui.test.ts` passed in Chrome (first paint 486 ms, 61 frames, tick-to-screen 34 ms). `tests/pair-ui.test.ts` passed in Chrome. `tests/global/audit.ts` — **115 passed, 0 issues**. Not re-run in this pass: `tests/liquidity-ui.test.ts`, `tests/live-ui.test.ts`, `tests/funds-ui.test.ts`, `tests/reference-ui.test.ts`, `tests/ops-desk.test.ts`, `tests/manual-deposit.test.ts`, `tests/start-meridex-pid.test.sh`, `tests/copy-lang.test.mjs`.

## Run #41 — non-crypto pairs open when clicked

No schema change. The click handler was not limited to crypto, and it did not throw. Direct URLs already opened `EUR/USD`, `XAU/XAG`, and `BRENT/USD`. The category tabs already filtered the list when the click landed on the tab. The simple ticket's asset list already included forex, metals, and commodities.

What failed after the run #40 desk: the pair row looked clickable, but only the name was wired. The price, which is most of the right-hand column, did nothing. Toasts sit on that same corner and were taking the click. At a window of 1100px or narrower the book and ticket grew with their content and pushed the pair list about 1700px down, off the first screen. A laptop window in that range showed the chart and the ticket, and the other markets were not there to open.

The whole row now selects the symbol, including the price. The star still only toggles the watchlist. The same row click is on the markets table and the home table. Toasts no longer take the click. Below 1100px the book and ticket scroll inside their own cells, and the pair list stays in a row on the first screen. The list itself scrolls. `tests/pair-ui.test.ts` clicked the price cell of EUR, GBP, and XAU at 1440, 1280, and 1024, then opened `XAU/XAG` and `BRENT/USD` from the URL and `EUR/USD` from the simple ticket.

A candle request that fails, a dropped socket, or a book that has not arrived after 2.5 seconds shows 这个品种的报价暂时不可用 / This quote is unavailable right now / Sebut harga ini tidak tersedia buat masa ini, with 重试 / Retry / Cuba lagi. The symbol stays selected, so another market can still be opened. On this host the gold and FX feeds were up, so a live `socket hang up` for XAU/USD was not reproduced. Aborting the XPT/USD candle request did show the retry line, and the header stayed on XPT/USD. An upstream feed miss does not by itself blank a market while the local book is still quoting.

The catalog has metals, crypto, commodities, and FX. It has no stock or index instruments, so there is no stock or index row to open.

`make test` was run twice. The first acceptance pass stopped on BTC 1-minute candles returning 11 bars from a short in-memory cache. The loader was not changed. The second pass returned 300 bars and passed, including `tests/pair-nav.test.ts`. Ledger invariants 64/64. The simple ticket still passes. The global audit is 115 passed, 0 issues. Product switches, liquidity providers, the kill switch, reference depth, and the demo paper wallet were left off.

## Run #40 — trading desk and public base fees

Migration `db/migrations/024_fee_schedule.sql` is required. The gateway applies it on boot (`schema_migrations` id `024_fee_schedule`). It adds `fee_tiers` and nullable `trades.buyer_fee_uusd`, `trades.seller_fee_uusd`, and `real_fills.fee_uusd`. Old fills are not updated. A second boot does not re-apply the file.

The spot page opens on the three-column desk: chart, this platform's book and its own prints, and the pair list. The ticket sits under the chart with Buy and Sell side by side. Each side has Limit, Market, Stop-limit, and OCO; Price, Amount, and Total with the unit inside the field; 25/50/75/100; available balance; an estimated fee; and a green Buy or red Sell button. Clicking a book price fills the price. The book can show both sides, bids, or asks, and a precision step groups levels. The bottom tabs are Open orders, Order history, Trade history, and Funds. Trade history shows the stored fee, or an em dash when the fill has none. The fee-rate control on the ticket explains maker versus taker and the 30-day tier. The page does not use another firm's name, logo, or colours.

简易 / Simple / Ringkas is still in the header. `meridex.advanced` set to `0` keeps the short ticket. The default is the desk.

Margin and perpetuals use the same kind of form when that product switch is on: Open/Close, Cross/Isolated, a leverage slider, Limit and Market, GTC, reduce-only, take-profit and stop-loss, Buy/Long and Sell/Short, a position card (size, entry, mark, liquidation, margin, unrealised PnL, ROE%), and Positions / Open orders / Order history / Trade history / Transaction history. Stop, IOC, FOK, and post-only are on the form and disabled. The live order API still accepts only market and limit, plus reduce-only, take-profit, stop-loss, leverage, and margin mode. Those four controls are not sent. Spot already accepts limit, market, IOC, FOK, post-only, stop-limit, and OCO, and the desk sends them. With the product switch off the page stays coming soon, including the perpetuals screenshots in this pass. Simulation labels stay on the paper book only. The reference-depth panel is unchanged and was left off.

Fees are whole basis points. One basis point is 0.01%. There is no token discount.

| Schedule | Before | After (stored) |
|---|---|---|
| Spot regular / VIP 0, 30-day volume under $1,000,000 | maker 0.10%, taker 0.20% | maker 0.10%, taker 0.10% |
| Spot VIP 1, from $1,000,000 | 0.08% / 0.16%, and a $50,000 hold at $100,000 volume | 0.09% / 0.10%, hold removed |
| Spot VIP 2, from $5,000,000 | 0.05% / 0.12% at $1,000,000, hold $250,000 | 0.08% / 0.10% |
| Spot VIP 3, from $20,000,000 | 0.02% / 0.08% at $10,000,000, hold $1,000,000 | 0.04% / 0.06% |
| Spot VIP 4, from $75,000,000 | none | maker 0.04%, taker 0.05% (a published 0.052% taker does not fit an integer basis point) |
| Perpetual VIP 0 | none (live fills were not charged) | maker 0.02%, taker 0.05% |
| Perpetual VIP 1, from $15,000,000 | none | 0.02% / 0.04% (maker 0.016% rounds to 2 bp) |
| Perpetual VIP 2, from $50,000,000 | none | 0.01% / 0.04% (0.014% and 0.035% rounded) |
| Perpetual VIP 3, from $100,000,000 | none | 0.01% / 0.03% (0.012% and 0.032% rounded) |
| Perpetual VIP 4, from $600,000,000 | none | 0.01% / 0.03% (0.010% and 0.030% rounded) |

Margin uses the spot rows. Names standard, silver, gold, and private stay as VIP 0–3 so rewards and the acceptance suite still resolve. VIP 4 and the perpetual rows live in `fee_tiers`. The fee page shows both tables, the signed-in tier, and a line that new rates apply to new fills only. Convert, deposit, and withdrawal numbers are unchanged.

The only admin editor is the fee table at the top of Content → Numbers. Other `fee.*` keys are hidden from the generic list. Saving a fee needs the owner's authenticator and writes `content_audit`. An empty code is `401 TOTP_REQUIRED` and writes nothing. A value outside the existing range is `400` before the code is checked. `convert.feeBps` still saves without an authenticator. Support cannot save numbers.

A new spot fill charges the buyer in the base just received and the seller in quote, both moved to the house bot when that account exists in the same entity and the balance covers it. The stored columns are the quote equivalent, or 0 when the move did not happen. A new margin or perpetual fill charges the product wallet when it covers the fee; a shortfall records 0 and does not fail the close. Marketable fills are taker. A resting limit that later matches is maker. Funding and interest rows do not get a trading fee. Statements and the report sum the stored fee columns. Null on an old fill counts as 0. The report does not restate old volume at the new rate. The standard taker fallback, used only when the schedule row is missing, is 10 bp.

`make test` passed, including `tests/fees.test.ts` (VIP 0 spot 10/10 and perpetual 2/5, validation before authenticator, audit on a change, restore to 10/10). Ledger invariants 64/64. The simple ticket still passes. Chrome overflow was 0 on the shots above. Product switches, liquidity providers, the kill switch, reference depth, and the demo paper wallet were left off.

Not done: live stop, IOC, FOK, and post-only on margin and perpetuals; a token-fee discount; rewriting historical fills; a perpetuals screenshot of the live form (the switch stayed off, so those shots are the coming-soon page); a production link to an outside exchange.

## Run #39 — test-venue adapters, still off

Migration `db/migrations/023_lp_test_adapters.sql` is required. The gateway applies it on boot. It adds three providers, all `enabled = false` and `mode = off`:

| Provider | Default host | Keys |
|---|---|---|
| binance-demo | `https://demo-fapi.binance.com` | `~/.meridex-secrets/binance-demo.env` (`BINANCE_DEMO_API_KEY`, `BINANCE_DEMO_API_SECRET`) |
| saxo-sim | `https://gateway.saxobank.com/sim/openapi` | `~/.meridex-secrets/saxo-sim.env` (`SAXO_SIM_TOKEN`, `SAXO_SIM_ACCOUNT_KEY`) |
| coinbase-sandbox | `https://api-public.sandbox.exchange.coinbase.com` | none; the adapter is a stub |

How to add a key file is `docs/LP_TEST_KEYS.md`. The directory should be mode 700 and the files mode 600. Restart the gateway after editing. `MERIDEX_SECRETS_DIR` is only a test hook. Keys are not in the repo, the database, or the admin JSON. The Liquidity page shows present or missing, connection status, last latency, and the last error code. It never shows the key.

Binance USDS-M demo REST uses HMAC SHA256 and the `X-MBX-APIKEY` header. The retired host `testnet.binancefuture.com` and production hosts (`fapi.binance.com`, `dapi.binance.com`, `api.binance.com`) are refused. A `demo-*.binance.com` https host, or a local mock, is allowed. Saxo uses the bearer token as supplied. There is no refresh. HTTP 401 is shown as 令牌已过期 / Token expired / Token tamat. The live Saxo gateway without `/sim` is refused.

Read-only calls are balance, price, and order status. Shadow logs the route it would send and does not POST. Live on these rows means live-to-test-environment: an order goes only to the demo or simulator host, and only after the owner's authenticator, with the same caps and audit as run #36. They stay off. Test connection is `POST /api/admin/liquidity/providers/:id/test`. It does not need an authenticator because it sends no order. A missing key returns `KEY_MISSING` and does not open a socket.

The Coinbase row is a stub on purpose. Keys are not available. `place` throws `LP_DOCS_REQUIRED` and the class never calls the network. The page says 还没有密钥，未连接.

`EUR/USD` → `FxSpot:21` is a sample map. Confirm the UIC in the Saxo simulator before using it.

This run did not call demo.binance.com or the Saxo simulator. No key file is on this machine. `tests/lp-adapters.test.ts` uses local mock servers only. `make test` passed, including that file. Chart history in the same pass: 300 bars, 49 ms cold / 25 ms warm, WebSocket 9,063 bytes, engine 1 ms, transit 1 ms. Reference depth on this host was a Coinbase book. The reference switch, product switches, liquidity providers, kill switch, and the demo paper wallet were left off.

Still missing: a production firm adapter, Saxo token refresh, Coinbase sandbox credentials, and any commercial fee or minimum. A renamed Binance demo host outside `demo-*.binance.com` needs a code change in `gateway/src/liquidity/hosts.ts`, not a production URL.

## Run #38 — reference market depth, switch off

Migration `db/migrations/022_reference_depth.sql` is required. The gateway applies it on boot. Leave the switch OFF. It does not turn on margin, perpetuals, copy, or any liquidity provider.

The customer spot page and the perps page can show a public book. The gateway reads Binance, Coinbase, and Kraken order books and prints with GET only. There is no API key and no order URL. If those books are unreachable, crypto falls back to a CoinGecko price, metals to the existing gold price (ounce, or kilograms for XAUKG), and FX to Frankfurter. A missing book is not invented. On this host BTC came back as a Coinbase book. The offline test covers the CoinGecko-only path: empty bids and asks, one reference price.

The panel is labelled 参考行情 / Reference market / Pasaran rujukan, with a sentence that it is not this platform's liquidity and that an order cannot be placed there. The platform book and its prints are labelled 本平台订单簿 / This platform's book and 本平台成交 / This platform's fills. Those sentences are in the customer catalog (`refTitle`, `refDisclaimer`, `ownBook`, `ownTape`, and the matching keys). A quote older than 4 seconds is marked stale.

The back office switch is on Content & parameters. Default off. Saving needs the owner's authenticator and writes `reference_depth_audit`. An empty code is `401 TOTP_REQUIRED` and writes no row. Support gets `403`. While the switch is off, the customer response is `{ enabled: false }` and the gateway does not call a public host. The panel is absent, including on the simple ticket. Perpetuals still say coming soon while that product switch is off; the reference panel appears there only when its own switch is on, and it does not add an order ticket.

Chart path, measured again with the reference switch off:

| | Run #37 | This run |
|---|---|---|
| XAU/USD 1m history | 300 bars, 62 ms cold / 27 ms warm | 300 bars, 48 ms cold / 25 ms warm |
| WebSocket book | about 9,000 bytes, engine under 1 ms, transit 1–3 ms | 9,055 bytes, engine 0 ms, transit 1 ms |
| First chart paint | 338 ms | 297 ms |
| Tick to screen | 25 ms | 21 ms |
| Pan / zoom frames | 61 | 61 |

The simple ticket is unchanged. First paint stayed under 1 s, tick-to-screen under 300 ms, and pan/zoom at 61 frames in one second.

Still not instant: the maker loop still prints a new quote about every 1.5 s. A public book source that does not answer is abandoned after 1.5 s; the other sources run at the same time, so a CoinGecko-only machine waits on the slowest dead book source, not on four of them in a row. The result is cached for 1.5 s and the page asks again every 2 s. The candle HTTP call still reads the 24 h stats. The market list still polls every 4 s. History still refreshes every 30 s. Binance candle history is still unavailable from this host.

## Run #37 — simple order ticket and chart latency

No schema change.

The trade page opens on a short ticket. Spot always uses it. Margin and perpetuals use the same shape when that product is on; while the switch is off the page stays coming-soon. Simulation still uses the paper book and still shows the simulation badge only while paper is on.

The simple ticket is: pick the asset, large Buy and Sell, one amount with a US-dollar / quantity toggle and 25/50/75/100, one line for what you pay, what you receive, and the fee, then one confirm step. Leverage products add a 1×–3× slider (default inside that range), a sentence for the liquidation price, and a plain risk line. Limit, take-profit, stop, reduce-only, and margin mode sit under Advanced. The choice is remembered (`meridex.advanced` on spot, `meridex.liveAdvanced` on margin and perpetuals). A three-step hint dismisses and stays dismissed. A short balance shows “Not enough balance. Deposit?” with a link to deposit. New sentences are in the customer catalog in Chinese, English, and Malay (`hintTradeTitle`, `hintTrade1`, `hintTrade2`, `hintTrade3`, `youPay`, `youReceive`, `needDeposit`, `liqPlain`, `levRisk`, and the matching keys). Quantity still follows the instrument. The server accepts 1×; 2× and above are unchanged. Product switches were left off. The demo paper wallet was left off.

Chart path, measured on this machine:

| | Before | After |
|---|---|---|
| XAU/USD 1m history | 1,897 bars, 174 KB, 75 ms cold / 33 ms warm | 300 bars, 62 ms cold / 27 ms warm, in-memory hit |
| History cache | `max-age=5`, full table | `max-age=1, stale-while-revalidate=5` for the tail; `max-age=60` for older pages; `x-candle-cache: hit` |
| WebSocket book | 23,544 bytes, 102 sampled prints queried every broadcast | about 9,000 bytes, empty `chart`, last candle per timeframe from memory |
| Engine book call | included in the heavy broadcast | 0 ms (under 1 ms) |
| Gateway send to client | not split out | 1–3 ms |
| First chart paint | full series replaced every 4 s and on every last price | 338 ms from navigation to the first canvas paint |
| Tick to screen | React replaced the whole bar array, then `setData` | 25 ms from gateway `sentAt` to `series.update` |
| Pan / zoom frames | redraw tied to those `setData` calls | 61 frames in one second of wheel input |

Targets: first paint under 1 s, tick-to-screen under 300 ms, 60 fps on pan/zoom. All three held locally.

The live candle is pushed on the existing WebSocket. The browser does not poll history for the last price. The chart component stays dynamically imported, coalesces book frames with `requestAnimationFrame`, updates only the last bar, and reconnects with backoff. A Live mark shows while the socket is up. Older bars load when the view is zoomed to the left edge. Indicator math for MACD and RSI runs when the history array changes, not on each tick. Simple mode leaves those off.

Still not instant: the maker loop still produces a new quote about every 1.5 s, so a brand-new price cannot appear faster than that. The candle HTTP call still reads the 24 h stats (the cold 50 ms). The market list still polls every 4 s and does not redraw the series. A quiet refresh of history still runs every 30 s. Binance candle history is still unavailable from this host; the chart uses local bars.

## Run #36 — local liquidity adapter, still off

Migrations `db/migrations/020_liquidity.sql` and `db/migrations/021_mark_coingecko.sql` are required. The gateway applies them on boot. Leave every provider OFF and the kill switch clear. The three product switches stay OFF.

The gateway has a `LiquidityProvider` contract: quote, subscribe, place, cancel, status, fills, balances, positions, heartbeat. Config lives in `lp_providers` (name, type, base URL, enabled, mode OFF/SHADOW/LIVE, symbol map, markup bps, min and max size, per-order and daily notional caps). `secret_ref` is only a name. The value is read from that environment variable or from `data/lp-secrets.json`, which is gitignored. The admin response says present or missing and does not contain the value. The mock provider is in-process and deterministic. The REST and FIX files are skeletons: they do not invent a firm's paths or messages, and `place` throws `LP_DOCS_REQUIRED`.

OFF is unchanged internal matching. SHADOW logs the intended provider, price, and size against the internal fill and does not call `place`. LIVE hedges first, one customer order to one firm, and fails over only when the first firm filled zero. A reject with nothing filled rejects the customer order. A partial fill is not sent to a second firm or back to the internal engine. Spot LIVE posts `lp_spot` between the customer available balance and the house bank or vault, does not insert `trades`, and does not use `reserved`. Resting limits, stops, and OCO return `LP_RESTING` in LIVE so they are not warehoused. Margin and perpetuals route only when that product switch is already on. The kill switch rejects new live routes immediately. Turning a provider to LIVE, changing the kill switch, a mark source, or an exposure cap needs the owner's authenticator and writes `lp_audit`. Support cannot do it. An empty code is `401 TOTP_REQUIRED` and writes no audit row.

Mark price for margin and perpetuals is the median of fresh public prints from Binance, Coinbase, Kraken, and CoinGecko. No key. Outliers and stale prints are dropped. Fewer than two survivors, or a print more than the configured distance from the local book, falls back to the book and raises an alert. Verify each source's terms. From this host Binance's public ticker returned HTTP 451 and shows unavailable; the other three quoted BTC, ETH, SOL, and XRP. Metals are not mapped, so gold stays on the local book.

The admin page is 流动性 / Liquidity / Kecairan. It shows mode, key present or missing, health, today's routed notional, reject rate, shadow-versus-internal gap, net customer quantity against the hedge, CSV reconciliation, source health, and one kill switch. A CSV break is stored and does not change a customer balance. Disconnects, reject spikes, and exposure over a cap that the owner has set notify the owner. A cap of 0 does not alert.

`tests/liquidity.test.ts` covers the mock contract, failover, the partial-fill stop, the kill switch, shadow `place` count staying 0, outlier rejection, TOTP and audit, statement import leaving balances unchanged, duplicate fill ids, and ledger invariants. Chrome at 1440 and 390 opened the page in Chinese, English, and Malay with no page overflow. Providers and the kill switch were left off.

Not in this run: a real firm's adapter, the number of shadow days (the owner chooses it), B-book, model 乙, best-price routing, split orders, FIX or REST order entry, settlement of provider cash, and an automatic hedge of positions already on the internal book. The customer banner still says internal liquidity. The partner licence remains the owner's unverified statement. The checklist is in `docs/LIQUIDITY_MM_INTEGRATION.md` section 12.

## Run #35 — one funds desk and a customer profile

Migration `db/migrations/019_fund_accounts.sql` is required. The gateway applies it on boot.

Every user, including accounts that already existed, has a fund id `MXF-` plus eight hexadecimal digits of the user id. It is unique, it does not change, and a new registration gets one from a database trigger. The customer wallet and the deposit page show it. The deposit reference the customer copies is that fund id. The old bank reference stays on the deposit profile for wires that already used it. Staff search matches either. The words 资金账号 / Fund ID / ID dana are in the customer string catalog (`funds.zh.fundId`, `funds.en.fundId`, `funds.ms.fundId`, and the matching `fundIdHint` keys), so Content & parameters can edit them. Admin chrome stays on `tri()`.

The main admin nav replaces the separate credit and withdrawal links with 资金 and 客户. `/deposits` and `/withdrawals` open the funds screen. Home to-do 待入金 and 待出金 go there.

资金 has two tabs. 入金 lists claims (client, asset and chain, amount, reference, time) with one button, 确认到账并入账. The confirm dialog prefills the amount, takes an optional tx hash, and one authenticator code. 出金 lists the review queue. 通过 and 拒绝 use one code; 拒绝 uses a reason list. After 通过, the next dialog is 标记已汇出 and records the tx hash. Approving still settles the hold. Marking sent only sets status `posted` and does not post another journal row. `withdraw.reviewUsd` is unchanged. A search line and a status filter sit above the list. 更多 holds a credit with no claim, a reversal, the reconciliation link, and the review-amount note. An empty authenticator code is `401 TOTP_REQUIRED` and does not credit. Support cannot decide a withdrawal. A deposit card in chat does not change the balance.

客户 searches email, phone (the callback number on a ticket; there is no separate phone column), name, fund id, or UID. The profile shows the fund id, UID, name, email, phone, registration, KYC status and tier, country, risk flags, active or frozen, the internal-test and staff badges, the account manager, and the referral. Balances are spot, reserved, withdraw hold, margin, and derivatives, with a USD total. Deposit and withdrawal histories are the full ledger trail (time, asset and chain, amount, address or reference, tx hash, status, who acted, reason) plus totals. Those totals are the customer-account journal sums: deposits `deposit_usd` and `vault_in` minus `deposit_reversal`, withdrawals `withdraw_usd` and `vault_out`. CSV export is one file per history. The page also shows assigned deposit addresses, recent orders, fills, and open positions, recent logins and whether the authenticator is on, tickets, and a link into the support thread. Staff notes are stored. Freeze and unfreeze go through the existing `freeze_user` change request; the owner is an admin, so one authenticator code approves it. Support cannot freeze. The profile never returns a password, authenticator secret, or recovery code. Opening the profile, exporting CSV, adding a note, and each funds action write `security_events`.

Internal-test accounts are badged on the list and the profile. They still cannot be credited. The operations customer count still excludes `is_internal_test` and `address_pool_owner`.

Chrome, signed in: the home to-do opened 资金, a 9.00 USD claim was confirmed and credited, the English profile showed that fund id and the reference, Bahasa 出金 fit a 390px width with no page overflow, and the customer wallet and deposit page showed `MXF-00000001`. Product switches stayed off. The demo account was left unfrozen.

## Run #34 — owner product switches

Migration `db/migrations/018_live_products.sql` is required. The gateway applies it on boot. Leave the three switches OFF when you are done.

Each of margin, perpetuals, and copy has one ON/OFF switch on the admin content page. Saving needs the owner's authenticator code and writes `live_product_audit`. Support cannot flip it. Missing or wrong codes return `TOTP_REQUIRED` or `INVALID_TOTP` and do not write an audit row. The default cap is 500 USD notional and 3× leverage, editable between 1 and 1,000,000 USD and 2× to 10×.

- OFF, and the customer has nothing open: coming soon. No ticket, no marks, no tab badge.
- OFF, and a real position or product-wallet balance remains: reduce or close only. New orders return `LIVE_OFF`. Balance can move back to spot. Adding margin is refused.
- ON: verified customers use the normal ticket against the margin wallet or the derivatives wallet. The page shows `内部流动性，尚未接入外部做市商` / `Internal liquidity, no external market maker yet` / `Kecairan dalaman, belum ada pembuat pasaran luar`. There is no simulation badge. This is an internal book. It is not an external market maker and it is not a licence.
- Simulation still uses `paper_*` and, for copy, the fictional leaders. A paper order does not move real USD. US residents still get `US_RETAIL_BLOCK` on margin and perpetuals. Copy can be followed by a verified US customer. Internal-test accounts stay `PLAY_ONLY`.

Real mode, in Chinese, English, and Malay:

- Margin and perpetuals: leverage, isolated or cross, long and short, market and limit, reduce-only, take-profit and stop-loss, estimated liquidation, add and remove margin, full and partial close, close-all confirmation, open orders with cancel, order history, and fills. Quantity, step, and tick follow the instrument (gold 0.100 g step 0.001 g tick $0.01, BTC minimum 0.0001 step 1 satoshi tick $1.00, ETH minimum 0.001 tick $0.10). Above 3×, or when estimated liquidation is within 20% of the mark, the ticket asks for a liquidation confirmation. Close-all and stopping a copy both ask before they send.
- Funding and margin interest are 1 bp per 8 hours and post on the real ledger (`live_funding`, `live_interest`). A forced funding and a forced interest fill are in `tests/live-products.test.ts`. Liquidation posts `live_liquidation` and does not mint a customer debt beyond the margin.
- Customer profit is paid from `live-book@internal.meridex`. A shortfall is `live_pnl_owed`, shown on the reconciliation exposure panel. It is not minted. Customer loss moves USD from that product wallet to the house. Live fills are not inserted into `trades`, so public volume is unchanged.
- Copy leaders are real customers who opted in. Stats come from their own non-copied closes. No closes means no win rate and an empty curve. Follow sets an allocation, a 10–200% ratio, and a max loss. Pause, resume, and stop work. Stop closes the copied positions. Fictional names are not returned.
- Spot, margin, and derivatives wallets transfer with `POST /api/wallets/transfer`. Transfer into a product wallet requires that product on (the derivatives wallet also accepts a transfer when copy is on).

The new invariant is `live_wallet_covers_margin`: the USD in the margin and derivatives buckets covers open position margin plus open-order reserves. Acceptance now reports 64/64. Public customer and volume figures still exclude `is_internal_test` and `address_pool_owner`. Bot flow is unchanged.

Chrome, signed in, paper off, switches off: `/margin`, `/perps`, and `/copy` show 即将开放 at 1440 and 390, with no ticket and no tab badges, and no page overflow. Perpetuals on: the notice, 数量（克） and 数量（BTC）, empty position/order/fill states, a below-minimum quantity error, the liquidation confirmation at 3×, and the same screen in English and Malay. Copy on: the notice, no fictional leader, no overflow at 390. Paper on: three 模拟 badges and the virtual-funds banner, and not the internal-liquidity line. Admin content shows the three switches. Reconciliation shows house exposure and PnL owed. Switches and the demo paper wallet were left off.

Not in this run: no external market-maker connection, no insurance fund, and no multi-source mark. The mark is the spot book. The design note in `docs/LIQUIDITY_MM_INTEGRATION.md` is still the external-provider plan.

## Run #31 — quantity units and simulation labels

No schema change.

- Quantity follows the instrument in Chinese, English, and Malay. Gold, silver, platinum, and palladium stay in grams. `XAUKG` stays in kilograms and `XAUOZ` in troy ounces. BTC, ETH, other crypto, FX, and commodities use that ticker. The same rule covers the perpetual ticket, the spot ticket, convert, positions, fills, and the funds activity amount.
- A new order starts at a small amount of that asset: 0.100 g of gold, 0.001 BTC, 0.01 ETH. A kilogram bar and a 0.100 oz bar stay on the exchange minimum, because that lot is already large.
- Outside simulation, leverage, perpetuals, and copy trading show a coming-soon panel. There is no order ticket and no mark prices. The tab badge (模拟 / Simulated / Simulasi), the licence pill, and the virtual-funds banner appear only while simulation is on. Spot, convert, and recurring stay on the real book and do not carry those badges. The header switch still turns simulation on. Those three products still refuse real-balance orders on the server.
- The new sentences are editable in Content & parameters: `gatedSoon`, `gatedBody`, `gatedCta`, `qtyWithUnit`, `qtyMin`, `unitGram`, `unitKg`, and `unitOz`, each in zh, en, and ms.

Chrome on the customer site (1440 and 390) signed in, opened perpetuals outside simulation (即将开放, no ticket, no tab badges), turned simulation on, and checked XAU 数量（克） at 0.100, BTC 数量（BTC） at 0.001, and ETH in English and Malay. Margin and copy matched. Spot, convert, recurring, funds, and the order list stayed clear of the virtual-funds banner. The admin content screen lists the new keys.

## What this pass added

- Withdrawal review. `withdraw.reviewUsd` in Content & parameters defaults to 0, so every real withdrawal waits. The amount is reserved in a `withdraw_hold` bucket (conservation still holds; the open-order `reserved` bucket is unchanged). The super-admin approves or rejects on `/withdrawals` with a fresh authenticator code. A rejection needs a reason and releases the hold. The customer gets an inbox notice. An amount strictly below a raised threshold still posts immediately. Internal-test accounts get `PLAY_ONLY` and never open a real rail. Requesting 20,000 USD still opens the `large_withdraw` surveillance alert. Empty TOTP is `401 TOTP_REQUIRED` and does not count as a failed code. Support can list the queue and cannot decide it.
- Deposit reconciliation at `/deposits/reconcile` (linked from Credits, not a new nav item). Filters: today, claims, credits, unmatched. CSV downloads the filter on screen.
- `scripts/backup-db.sh` writes `pg_dump -Fc --no-owner` to `~/meridex/backups`, keeps 7 dumps, appends `backup.log`, and writes `latest.json`. `scripts/com.meridex.backup.plist` is the 03:15 LaunchAgent (replace `/Users/YOU`). `RUN_LOCAL.md` also has the cron line and the restore command. The ops-desk test restored a dump into a scratch database, read `users`, and dropped the scratch database. The live file is `~/meridex/backups/latest.json` (`ok: true`, `2026-10-25T11:08:07Z`). The admin home shows that time and status.
- Admin home "To do today" / 今日待办 / Tugasan hari ini: pending claims, pending withdrawals, pending KYC, unanswered chats, feed problems, and the last backup, each with a count and a link.
- Admin pages that used `lang === "en" ? english : chinese` now use `tri()` (Chinese, English, Malay). Seeded help articles have `title_ms` and `body_ms`. Bahasa on `/help` shows those titles and bodies, plus the visible "Cari bantuan" hint.

A headless Chrome pass on 4318 (Bahasa, 1280 and 390) opened the home, followed the withdrawals link, switched a reconciliation filter, confirmed the CSV button, and opened Operations and Surveillance. `/help` in Bahasa showed the Malay article text. No page error on the home. The home did not overflow at 390px.

## What the global script exercises

- Customer routes, including markets (every row opens the terminal on that symbol), funds, account, support, and help. Bahasa, English, and Chinese on the home, rewards, support, inbox, developers, and help.
- Mobile 390×844 on the customer pages listed above. No page-level horizontal scroll.
- Admin, including credits, reconciliation, and withdrawals, at 1280 and 390. Address desk owner login.
- API: register, login, KYC, a 1.00 USD deposit and withdrawal (approved with the founder's code when the row is pending), ETH limit on the tick and cancel, chat, ledger invariants, reports, internal-test exclusion, role gates, fee range, pool TOTP, content override rendered as text.
- Security: anonymous `/api/me` is 401, a foreign `Origin` is 403, weak passwords and a KP residence are rejected, alert posts hit 429, staff and customer logins stay on their own portals, support cannot open the pool, risk cannot halt, ops cannot edit content, the main admin import route returns `POOL_DESK`.
- Bindings: 4317, 4318, 4319, 7108, 7109, and 5432 listen on 127.0.0.1.
- Resilience: the engine process was stopped and started again; gateway `/healthz` then reported `ok: true`. The gateway process was stopped and started again; `/healthz` returned 200. The engine is not probed on port 7109, because that server accepts one connection and the gateway holds it.

## Fixed earlier (still in place)

| Area | What changed |
|---|---|
| Startup | `start-meridex.sh` removes `postmaster.pid` only when that pid is not a running postgres process, then waits for `pg_isready`. |
| Product tour | The tour moves only when Next or Back is clicked. |
| Help copy | Each listed contract has its own book. Spot fees are basis points. |
| Fees on a phone | The fee table scrolls inside the page. |
| Compliance halt | The page sends a symbol and the gateway uppercases it. |
| Ops and surveillance | The screens show the rows the API returned. |
| Orders | An off-tick price is `TICK`. The book payload includes `tickSize`, so the audit prices a limit on the real tick. |

## Closed from the previous open list

| Was | Page | Now |
|---|---|---|
| med | Admin pages in Bahasa showed Chinese | Those pages call `tri()`. Chrome in Bahasa shows Tugasan hari ini, Pengeluaran, Penyelarasan deposit, Operasi, Pengawasan. |
| low | Help articles had no Malay body | `title_ms` / `body_ms` are stored and returned. `/help` shows them. |
| low | No withdrawal review queue | `/withdrawals` holds, approves, and rejects. The default threshold reviews every withdrawal. |

No high, medium, or low product issue is still open from this pass.

## Notes that are not defects

- Candle history reports `binance unavailable`. Other price sources are up, so `/healthz` feeds stay `ok: true`. The to-do panel counts that candle error (1). There is no separate feeds page; the count links to the home.
- The seeded support announcement is a single stored string. It does not follow the language control. That is content, not a missing page translation.
- Health checks go through gateway `/healthz`. A second client on port 7109 waits, which is the engine's one-connection design.

## How to re-run

```bash
make test
bash tests/start-meridex-pid.test.sh
node tests/copy-lang.test.mjs
./start-meridex.sh
cd gateway && npx tsx ../tests/ops-desk.test.ts
cd gateway && npx tsx ../tests/manual-deposit.test.ts
cd gateway && npx tsx ../tests/global/audit.ts
```

`make test` includes `tests/qty-unit.test.ts`, `tests/sim-mode-ui.test.mjs`, `tests/live-products.test.ts`, `tests/funds-desk.test.ts`, `tests/liquidity.test.ts`, `tests/simple-math.test.ts`, `tests/chart-perf.test.ts`, `tests/reference-depth.test.ts`, `tests/lp-adapters.test.ts`, `tests/fees.test.ts`, and `tests/pair-nav.test.ts`. Browser passes, when Chrome is available: `cd gateway && npx tsx ../tests/live-ui.test.ts`, `cd gateway && npx tsx ../tests/funds-ui.test.ts`, `cd gateway && npx tsx ../tests/liquidity-ui.test.ts`, `cd gateway && npx tsx ../tests/simple-ui.test.ts`, `cd gateway && npx tsx ../tests/reference-ui.test.ts`, and `cd gateway && npx tsx ../tests/pair-ui.test.ts`.
