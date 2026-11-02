-- Staff practice accounts. Play balances never enter accounts, balances, or trades.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_internal_test BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS users_internal_test_idx ON users (is_internal_test) WHERE is_internal_test;

CREATE TABLE IF NOT EXISTS play_balances (
  user_id BIGINT NOT NULL REFERENCES users (id),
  asset TEXT NOT NULL,
  available BIGINT NOT NULL DEFAULT 0 CHECK (available >= 0),
  reserved BIGINT NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  PRIMARY KEY (user_id, asset)
);

CREATE TABLE IF NOT EXISTS play_orders (
  id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  order_type TEXT NOT NULL,
  price_px BIGINT,
  stop_px BIGINT,
  qty BIGINT NOT NULL,
  leaves BIGINT NOT NULL,
  filled BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  fee_uusd BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS play_orders_user_idx ON play_orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS play_orders_open_idx ON play_orders (status) WHERE status IN ('open', 'armed');

CREATE TABLE IF NOT EXISTS play_trades (
  id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id),
  order_id TEXT NOT NULL REFERENCES play_orders (id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  price_px BIGINT NOT NULL,
  qty BIGINT NOT NULL,
  notional_uusd BIGINT NOT NULL,
  fee_uusd BIGINT NOT NULL,
  liquidity TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS play_trades_user_idx ON play_trades (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS play_moves (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id),
  actor_id BIGINT NOT NULL REFERENCES users (id),
  asset TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount BIGINT NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS play_moves_user_idx ON play_moves (user_id, id DESC);
