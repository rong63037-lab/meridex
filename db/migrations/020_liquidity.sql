-- Local liquidity-provider config. Modes default to off.
-- secret_ref is an environment-variable name or a key in data/lp-secrets.json.
-- The secret value is never stored in this database.

CREATE TABLE IF NOT EXISTS lp_providers (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('mock', 'rest', 'fix')),
  base_url TEXT NOT NULL DEFAULT '',
  secret_ref TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT false,
  mode TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'shadow', 'live')),
  priority INT NOT NULL DEFAULT 100,
  spread_markup_bps INT NOT NULL DEFAULT 0 CHECK (spread_markup_bps >= 0 AND spread_markup_bps <= 500),
  min_qty BIGINT NOT NULL DEFAULT 0 CHECK (min_qty >= 0),
  max_qty BIGINT NOT NULL DEFAULT 0 CHECK (max_qty >= 0),
  per_order_notional_uusd BIGINT NOT NULL DEFAULT 0 CHECK (per_order_notional_uusd >= 0),
  daily_notional_uusd BIGINT NOT NULL DEFAULT 0 CHECK (daily_notional_uusd >= 0),
  symbol_map JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO lp_providers (name, type, base_url, secret_ref, enabled, mode, priority)
VALUES
  ('mock', 'mock', '', 'LP_MOCK_KEY', false, 'off', 10),
  ('rest-skeleton', 'rest', '', 'LP_REST_KEY', false, 'off', 20),
  ('fix-skeleton', 'fix', '', 'LP_FIX_KEY', false, 'off', 30)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS lp_kill (
  id INT PRIMARY KEY CHECK (id = 1),
  stopped BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO lp_kill (id, stopped) VALUES (1, false) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS lp_audit (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id BIGINT,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lp_audit_idx ON lp_audit (id DESC);

CREATE TABLE IF NOT EXISTS lp_routes (
  id BIGSERIAL PRIMARY KEY,
  client_order_id TEXT NOT NULL UNIQUE,
  user_id BIGINT,
  venue TEXT NOT NULL CHECK (venue IN ('spot', 'convert', 'margin', 'perp')),
  mode TEXT NOT NULL,
  provider_id BIGINT REFERENCES lp_providers (id),
  failover_provider_id BIGINT,
  asset TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  qty BIGINT NOT NULL,
  intended_px BIGINT,
  internal_px BIGINT,
  external_px BIGINT,
  filled_qty BIGINT NOT NULL DEFAULT 0,
  notional_uusd BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  sent BOOLEAN NOT NULL DEFAULT false,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lp_routes_day_idx ON lp_routes (provider_id, created_at DESC);

CREATE TABLE IF NOT EXISTS lp_fills (
  id BIGSERIAL PRIMARY KEY,
  provider_id BIGINT NOT NULL REFERENCES lp_providers (id),
  fill_id TEXT NOT NULL,
  client_order_id TEXT NOT NULL,
  qty BIGINT NOT NULL,
  px BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, fill_id)
);

CREATE TABLE IF NOT EXISTS lp_statements (
  id BIGSERIAL PRIMARY KEY,
  provider_id BIGINT NOT NULL REFERENCES lp_providers (id),
  external_fill_id TEXT NOT NULL,
  client_order_id TEXT,
  symbol TEXT,
  side TEXT,
  qty TEXT,
  px TEXT,
  matched BOOLEAN NOT NULL DEFAULT false,
  break_reason TEXT,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, external_fill_id)
);

CREATE TABLE IF NOT EXISTS lp_alerts (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  asset TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  acked BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lp_alerts_idx ON lp_alerts (id DESC);

CREATE TABLE IF NOT EXISTS lp_exposure_caps (
  asset TEXT PRIMARY KEY,
  max_abs_qty BIGINT NOT NULL DEFAULT 0 CHECK (max_abs_qty >= 0)
);

CREATE TABLE IF NOT EXISTS lp_mark_sources (
  id TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT true,
  stale_ms INT NOT NULL DEFAULT 30000 CHECK (stale_ms >= 1000 AND stale_ms <= 300000),
  outlier_bps INT NOT NULL DEFAULT 100 CHECK (outlier_bps >= 1 AND outlier_bps <= 2000),
  max_book_drift_bps INT NOT NULL DEFAULT 500 CHECK (max_book_drift_bps >= 50 AND max_book_drift_bps <= 5000),
  symbol_map JSONB NOT NULL DEFAULT '{}'::jsonb,
  note TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO lp_mark_sources (id, enabled, symbol_map, note) VALUES
  (
    'binance',
    true,
    '{"BTC/USD":"BTCUSDT","ETH/USD":"ETHUSDT","SOL/USD":"SOLUSDT","XRP/USD":"XRPUSDT"}'::jsonb,
    'Public ticker, no key. Verify Binance terms before relying on this feed.'
  ),
  (
    'coinbase',
    true,
    '{"BTC/USD":"BTC-USD","ETH/USD":"ETH-USD","SOL/USD":"SOL-USD","XRP/USD":"XRP-USD"}'::jsonb,
    'Public spot price, no key. Verify Coinbase terms before relying on this feed.'
  ),
  (
    'kraken',
    true,
    '{"BTC/USD":"XBTUSD","ETH/USD":"ETHUSD","SOL/USD":"SOLUSD","XRP/USD":"XRPUSD"}'::jsonb,
    'Public ticker, no key. Verify Kraken terms before relying on this feed.'
  )
ON CONFLICT (id) DO NOTHING;
