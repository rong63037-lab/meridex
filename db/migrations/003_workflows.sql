-- Gateway-side workflows. The matching engine still only sees limit, market, IOC, FOK, and post-only.

ALTER TABLE user_orders ADD COLUMN IF NOT EXISTS stop_price_cents BIGINT;
ALTER TABLE user_orders ADD COLUMN IF NOT EXISTS stop_limit_cents BIGINT;
ALTER TABLE user_orders ADD COLUMN IF NOT EXISTS group_id TEXT;

CREATE INDEX IF NOT EXISTS user_orders_trigger_idx ON user_orders (status, order_type);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id),
  ip TEXT,
  country TEXT,
  user_agent TEXT,
  revoked BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS login_events (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id),
  ip TEXT,
  country TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS login_events_user_idx ON login_events (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id),
  label TEXT NOT NULL,
  prefix TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id BIGINT PRIMARY KEY REFERENCES users (id),
  fills BOOLEAN NOT NULL DEFAULT true,
  rejects BOOLEAN NOT NULL DEFAULT true,
  announcements BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rail_transfers (
  id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id),
  direction TEXT NOT NULL CHECK (direction IN ('deposit', 'withdraw')),
  amount_uusd BIGINT NOT NULL CHECK (amount_uusd > 0),
  status TEXT NOT NULL CHECK (status IN ('submitted', 'processing', 'settled', 'failed')),
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rail_transfers_user_idx ON rail_transfers (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS redemptions (
  id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id),
  product TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('delivery', 'vault_pickup')),
  qty INT NOT NULL CHECK (qty > 0),
  metal_mg BIGINT NOT NULL,
  fee_uusd BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requested', 'processing', 'ready', 'failed', 'cancelled')),
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS redemptions_user_idx ON redemptions (user_id, created_at DESC);
