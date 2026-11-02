-- Trading modes. Licensed products never post to the double-entry ledger.
-- Margin and perpetuals stay blocked for US residents even if a row is edited.

CREATE TABLE IF NOT EXISTS mode_access (
  mode TEXT NOT NULL CHECK (mode IN ('convert', 'recurring', 'paper', 'margin', 'perp', 'copy')),
  country TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('allow', 'pending', 'block')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (mode, country)
);

CREATE TABLE IF NOT EXISTS mode_audit (
  id BIGSERIAL PRIMARY KEY,
  mode TEXT NOT NULL,
  country TEXT NOT NULL,
  previous_access TEXT,
  access TEXT NOT NULL,
  actor_user_id BIGINT,
  actor_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO mode_access (mode, country, access) VALUES
  ('convert', 'SG', 'allow'),
  ('convert', 'US', 'allow'),
  ('convert', 'MY', 'pending'),
  ('recurring', 'SG', 'allow'),
  ('recurring', 'US', 'allow'),
  ('recurring', 'MY', 'pending'),
  ('paper', 'SG', 'allow'),
  ('paper', 'US', 'allow'),
  ('paper', 'MY', 'pending'),
  ('margin', 'SG', 'block'),
  ('margin', 'US', 'block'),
  ('margin', 'MY', 'block'),
  ('perp', 'SG', 'block'),
  ('perp', 'US', 'block'),
  ('perp', 'MY', 'block'),
  ('copy', 'SG', 'block'),
  ('copy', 'US', 'block'),
  ('copy', 'MY', 'block')
ON CONFLICT (mode, country) DO NOTHING;

INSERT INTO mode_audit (mode, country, previous_access, access, actor_email)
SELECT mode, country, NULL, access, 'seed'
FROM mode_access
WHERE NOT EXISTS (SELECT 1 FROM mode_audit);

CREATE TABLE IF NOT EXISTS convert_quotes (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  qty BIGINT NOT NULL,
  price_px BIGINT NOT NULL,
  touch_px BIGINT NOT NULL,
  notional_uusd BIGINT NOT NULL,
  fee_uusd BIGINT NOT NULL,
  spread_bps INT NOT NULL,
  slippage_bps INT NOT NULL,
  namespace TEXT NOT NULL CHECK (namespace IN ('real', 'paper')),
  status TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS convert_quotes_user_idx ON convert_quotes (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS convert_fills (
  id BIGSERIAL PRIMARY KEY,
  quote_id UUID NOT NULL REFERENCES convert_quotes(id),
  user_id BIGINT NOT NULL REFERENCES users(id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  qty BIGINT NOT NULL,
  price_px BIGINT NOT NULL,
  notional_uusd BIGINT NOT NULL,
  fee_uusd BIGINT NOT NULL,
  path TEXT NOT NULL CHECK (path IN ('ioc', 'principal')),
  namespace TEXT NOT NULL CHECK (namespace IN ('real', 'paper')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS convert_fills_user_idx ON convert_fills (user_id, id DESC);

CREATE TABLE IF NOT EXISTS recurring_plans (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  symbol TEXT NOT NULL,
  amount_uusd BIGINT NOT NULL,
  cadence TEXT NOT NULL CHECK (cadence IN ('daily', 'weekly', 'monthly')),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'canceled')),
  namespace TEXT NOT NULL CHECK (namespace IN ('real', 'paper')),
  next_run_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recurring_plans_due_idx ON recurring_plans (status, next_run_at);

CREATE TABLE IF NOT EXISTS recurring_runs (
  id BIGSERIAL PRIMARY KEY,
  plan_id BIGINT NOT NULL REFERENCES recurring_plans(id),
  user_id BIGINT NOT NULL REFERENCES users(id),
  symbol TEXT NOT NULL,
  amount_uusd BIGINT NOT NULL,
  qty BIGINT,
  price_px BIGINT,
  status TEXT NOT NULL,
  detail TEXT,
  namespace TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recurring_runs_plan_idx ON recurring_runs (plan_id, id DESC);

CREATE TABLE IF NOT EXISTS demo_clock (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  multiplier INT NOT NULL DEFAULT 1 CHECK (multiplier >= 1 AND multiplier <= 3600)
);

INSERT INTO demo_clock (id, multiplier) VALUES (1, 1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS paper_margin (
  user_id BIGINT PRIMARY KEY REFERENCES users(id),
  mode TEXT NOT NULL CHECK (mode IN ('cross', 'isolated')),
  leverage INT NOT NULL CHECK (leverage >= 2 AND leverage <= 10),
  borrowed_uusd BIGINT NOT NULL DEFAULT 0 CHECK (borrowed_uusd >= 0)
);

CREATE TABLE IF NOT EXISTS paper_perps (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  qty BIGINT NOT NULL,
  entry_px BIGINT NOT NULL,
  leverage INT NOT NULL,
  margin_uusd BIGINT NOT NULL,
  tp_px BIGINT,
  sl_px BIGINT,
  status TEXT NOT NULL,
  realized_uusd BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS paper_perps_user_idx ON paper_perps (user_id, id DESC);

CREATE TABLE IF NOT EXISTS paper_copy_follows (
  user_id BIGINT NOT NULL REFERENCES users(id),
  leader_id TEXT NOT NULL,
  allocation_uusd BIGINT NOT NULL,
  max_drawdown_bps INT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, leader_id)
);

CREATE TABLE IF NOT EXISTS paper_copy_trades (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  leader_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  qty BIGINT NOT NULL,
  price_px BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS paper_copy_trades_user_idx ON paper_copy_trades (user_id, id DESC);
