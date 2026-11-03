.PHONY: demo test engine-test gateway-test acceptance ledger-stress reset

ENGINE_BIN=engine/target/debug/meridex-engine
JOURNAL?=data/engine-journal.jsonl

demo: $(ENGINE_BIN)
	mkdir -p data
	ENGINE_BIND=0.0.0.0:7109 ENGINE_JOURNAL=$(JOURNAL) ENGINE_FSYNC_EVERY=25 $(ENGINE_BIN) serve

$(ENGINE_BIN):
	cargo build --manifest-path engine/Cargo.toml

engine-test:
	cargo test --manifest-path engine/Cargo.toml -- --test-threads=8

gateway-test:
	cd gateway && npx tsx src/totp.test.ts && npx tsx src/addresses.test.ts && npx tsx src/originPolicy.test.ts && npx tsx src/runtimeFlags.test.ts

ui-test:
	node tests/sim-mode-ui.test.mjs
	cd gateway && npx tsx ../tests/qty-unit.test.ts

acceptance:
	cd gateway && npx tsx ../tests/acceptance/run.ts

ledger-stress:
	cd gateway && npx tsx scripts/ledger-stress.ts

test: engine-test gateway-test ui-test acceptance
	cd gateway && npx tsx ../tests/live-products.test.ts
	cd gateway && npx tsx ../tests/funds-desk.test.ts
	cd gateway && npx tsx ../tests/liquidity.test.ts
	cd gateway && npx tsx ../tests/simple-math.test.ts
	cd gateway && npx tsx ../tests/chart-perf.test.ts
	cd gateway && npx tsx ../tests/reference-depth.test.ts
	cd gateway && npx tsx ../tests/lp-adapters.test.ts
	cd gateway && npx tsx ../tests/fees.test.ts
	cd gateway && npx tsx ../tests/pair-nav.test.ts
