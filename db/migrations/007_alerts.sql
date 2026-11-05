-- Per-user price alerts, the in-app notice centre, and a server-side watchlist.

CREATE TABLE IF NOT EXISTS price_alerts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('above', 'below')),
  price_px BIGINT NOT NULL,
  armed BOOLEAN NOT NULL DEFAULT TRUE,
  triggered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS price_alerts_armed_idx ON price_alerts (armed) WHERE armed;

CREATE TABLE IF NOT EXISTS user_notices (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,
  price_px BIGINT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_notices_user_idx ON user_notices (user_id, id DESC);

CREATE TABLE IF NOT EXISTS watchlist (
  user_id BIGINT NOT NULL REFERENCES users(id),
  symbol TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, symbol)
);
