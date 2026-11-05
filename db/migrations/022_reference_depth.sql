-- Owner switch for the public reference book on the customer trade pages.
-- Default off. The gateway only reads public market data, and only while this is on.

CREATE TABLE IF NOT EXISTS reference_depth (
  id INT PRIMARY KEY CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT false,
  stale_ms INT NOT NULL DEFAULT 4000 CHECK (stale_ms >= 1000 AND stale_ms <= 60000),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO reference_depth (id, enabled, stale_ms)
VALUES (1, false, 4000)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS reference_depth_audit (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id BIGINT,
  actor_email TEXT NOT NULL,
  previous JSONB,
  next JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reference_depth_audit_idx ON reference_depth_audit (id DESC);
