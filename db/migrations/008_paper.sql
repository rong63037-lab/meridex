-- Paper trading is a separate namespace. These tables are never read by the
-- double-entry ledger, checkInvariants, or customer balance queries.

CREATE TABLE IF NOT EXISTS paper_wallets (
  user_id BIGINT PRIMARY KEY REFERENCES users(id),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reset_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS paper_balances (
  user_id BIGINT NOT NULL REFERENCES users(id),
  asset TEXT NOT NULL,
  available BIGINT NOT NULL DEFAULT 0,
  reserved BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, asset),
  CHECK (available >= 0),
  CHECK (reserved >= 0)
);

CREATE TABLE IF NOT EXISTS paper_orders (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  order_type TEXT NOT NULL,
  price_px BIGINT,
  qty BIGINT NOT NULL,
  leaves BIGINT NOT NULL,
  filled BIGINT NOT NULL DEFAULT 0,
  filled_notional BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  reject_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS paper_orders_user_idx ON paper_orders (user_id, id DESC);

CREATE TABLE IF NOT EXISTS paper_trades (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  order_id BIGINT NOT NULL REFERENCES paper_orders(id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  price_px BIGINT NOT NULL,
  qty BIGINT NOT NULL,
  notional_uusd BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS paper_trades_user_idx ON paper_trades (user_id, id DESC);

CREATE TABLE IF NOT EXISTS equity_snapshots (
  user_id BIGINT NOT NULL REFERENCES users(id),
  namespace TEXT NOT NULL CHECK (namespace IN ('real', 'paper')),
  day DATE NOT NULL,
  equity_uusd BIGINT NOT NULL,
  PRIMARY KEY (user_id, namespace, day)
);
