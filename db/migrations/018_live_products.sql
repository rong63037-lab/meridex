-- Owner on/off switches for margin, perpetuals, and copy.
-- Real positions post to customer margin / derivatives wallets. The paper tables are untouched.
-- live-book is the house counterparty for realised PnL. It is not a customer and cannot sign in.

CREATE TABLE IF NOT EXISTS live_products (
  product TEXT PRIMARY KEY CHECK (product IN ('margin', 'perp', 'copy')),
  enabled BOOLEAN NOT NULL DEFAULT false,
  max_notional_uusd BIGINT NOT NULL CHECK (max_notional_uusd > 0),
  max_leverage INT NOT NULL CHECK (max_leverage >= 2 AND max_leverage <= 10),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO live_products (product, enabled, max_notional_uusd, max_leverage) VALUES
  ('margin', false, 500000000, 3),
  ('perp', false, 500000000, 3),
  ('copy', false, 500000000, 3)
ON CONFLICT (product) DO NOTHING;

CREATE TABLE IF NOT EXISTS live_product_audit (
  id BIGSERIAL PRIMARY KEY,
  product TEXT NOT NULL,
  actor_user_id BIGINT,
  actor_email TEXT NOT NULL,
  previous JSONB,
  next JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS live_product_audit_idx ON live_product_audit (id DESC);

CREATE TABLE IF NOT EXISTS live_pnl_owed (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  product TEXT NOT NULL,
  amount_uusd BIGINT NOT NULL CHECK (amount_uusd > 0),
  ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS real_settings (
  user_id BIGINT NOT NULL REFERENCES users(id),
  product TEXT NOT NULL CHECK (product IN ('margin', 'perp')),
  mode TEXT NOT NULL CHECK (mode IN ('cross', 'isolated')),
  leverage INT NOT NULL CHECK (leverage >= 2 AND leverage <= 10),
  PRIMARY KEY (user_id, product)
);

CREATE TABLE IF NOT EXISTS real_orders (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  product TEXT NOT NULL CHECK (product IN ('margin', 'perp')),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  order_type TEXT NOT NULL CHECK (order_type IN ('market', 'limit')),
  qty BIGINT NOT NULL CHECK (qty > 0),
  limit_px BIGINT,
  leverage INT NOT NULL,
  margin_mode TEXT NOT NULL CHECK (margin_mode IN ('cross', 'isolated')),
  reduce_only BOOLEAN NOT NULL DEFAULT false,
  reserved_margin_uusd BIGINT NOT NULL DEFAULT 0 CHECK (reserved_margin_uusd >= 0),
  tp_px BIGINT,
  sl_px BIGINT,
  status TEXT NOT NULL,
  filled_qty BIGINT NOT NULL DEFAULT 0,
  avg_px BIGINT,
  reject_reason TEXT,
  copy_follow_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS real_orders_user_idx ON real_orders (user_id, id DESC);
CREATE INDEX IF NOT EXISTS real_orders_open_idx ON real_orders (status, id);

CREATE TABLE IF NOT EXISTS real_positions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  product TEXT NOT NULL CHECK (product IN ('margin', 'perp')),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  qty BIGINT NOT NULL CHECK (qty > 0),
  entry_px BIGINT NOT NULL,
  leverage INT NOT NULL,
  margin_uusd BIGINT NOT NULL CHECK (margin_uusd >= 0),
  margin_mode TEXT NOT NULL CHECK (margin_mode IN ('cross', 'isolated')),
  tp_px BIGINT,
  sl_px BIGINT,
  status TEXT NOT NULL,
  realized_uusd BIGINT NOT NULL DEFAULT 0,
  next_funding_at TIMESTAMPTZ NOT NULL,
  copy_follow_id BIGINT,
  leader_position_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS real_positions_open_idx ON real_positions (status, product, symbol);
CREATE INDEX IF NOT EXISTS real_positions_user_idx ON real_positions (user_id, status, id DESC);
CREATE INDEX IF NOT EXISTS real_positions_leader_idx ON real_positions (leader_position_id) WHERE leader_position_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS real_fills (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT,
  position_id BIGINT,
  user_id BIGINT NOT NULL REFERENCES users(id),
  product TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  qty BIGINT NOT NULL DEFAULT 0,
  price_px BIGINT NOT NULL DEFAULT 0,
  notional_uusd BIGINT NOT NULL DEFAULT 0,
  realized_uusd BIGINT NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS real_fills_user_idx ON real_fills (user_id, id DESC);

CREATE TABLE IF NOT EXISTS real_copy_leaders (
  user_id BIGINT PRIMARY KEY REFERENCES users(id),
  display_name TEXT NOT NULL,
  opted_in BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS real_copy_follows (
  id BIGSERIAL PRIMARY KEY,
  follower_id BIGINT NOT NULL REFERENCES users(id),
  leader_id BIGINT NOT NULL REFERENCES users(id),
  allocation_uusd BIGINT NOT NULL CHECK (allocation_uusd > 0),
  ratio_bps INT NOT NULL CHECK (ratio_bps >= 1000 AND ratio_bps <= 20000),
  max_loss_uusd BIGINT NOT NULL CHECK (max_loss_uusd > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'stopped')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (follower_id, leader_id)
);

CREATE INDEX IF NOT EXISTS real_copy_follows_leader_idx ON real_copy_follows (leader_id, status);

INSERT INTO users (email, password_hash, totp_secret, role, entity_id, jurisdiction, totp_enabled)
SELECT 'live-book@internal.meridex', 'disabled', '<redacted>', 'bot', 'SG-OPCO', 'SG', false
WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = 'live-book@internal.meridex');
