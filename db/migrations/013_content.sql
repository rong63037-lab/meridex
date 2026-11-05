CREATE TABLE IF NOT EXISTS content_overrides (
  lang TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_by BIGINT REFERENCES users (id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (lang, key)
);

CREATE TABLE IF NOT EXISTS content_audit (
  id BIGSERIAL PRIMARY KEY,
  actor_id BIGINT REFERENCES users (id),
  lang TEXT NOT NULL,
  key TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS business_params (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by BIGINT REFERENCES users (id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS content_audit_created_idx ON content_audit (created_at DESC);
