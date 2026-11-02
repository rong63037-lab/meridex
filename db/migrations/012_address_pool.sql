-- Founder-imported deposit address pool. One owner account writes; everyone else reads.
-- Audit rows are append-only. Assigned addresses stay attributable after an edit or retirement.

ALTER TABLE users ADD COLUMN IF NOT EXISTS address_pool_owner BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_hashes TEXT NOT NULL DEFAULT '[]';
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_pending TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS users_one_pool_owner ON users (address_pool_owner) WHERE address_pool_owner;

CREATE TABLE IF NOT EXISTS totp_lockouts (
  user_id BIGINT PRIMARY KEY REFERENCES users (id),
  fails INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS address_pool (
  id BIGSERIAL PRIMARY KEY,
  asset TEXT NOT NULL,
  network TEXT NOT NULL,
  address TEXT NOT NULL,
  address_hash TEXT NOT NULL,
  memo TEXT,
  min_amount TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('available', 'assigned', 'retired')),
  user_id BIGINT REFERENCES users (id),
  batch_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS address_pool_addr_uidx ON address_pool (lower(address));
CREATE UNIQUE INDEX IF NOT EXISTS address_pool_one_active
  ON address_pool (user_id, asset, network) WHERE status = 'assigned';
CREATE INDEX IF NOT EXISTS address_pool_available_idx
  ON address_pool (asset, network, id) WHERE status = 'available';

CREATE TABLE IF NOT EXISTS address_history (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id),
  asset TEXT NOT NULL,
  network TEXT NOT NULL,
  address TEXT NOT NULL,
  address_hash TEXT NOT NULL,
  pool_id BIGINT REFERENCES address_pool (id),
  active BOOLEAN NOT NULL DEFAULT true,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS address_history_user_idx ON address_history (user_id, asset, network);
CREATE INDEX IF NOT EXISTS address_history_addr_idx ON address_history (lower(address));

CREATE TABLE IF NOT EXISTS pool_thresholds (
  asset TEXT NOT NULL,
  network TEXT NOT NULL,
  threshold INT NOT NULL DEFAULT 2 CHECK (threshold >= 0),
  PRIMARY KEY (asset, network)
);

CREATE TABLE IF NOT EXISTS pool_audit (
  id BIGSERIAL PRIMARY KEY,
  actor_id BIGINT,
  action TEXT NOT NULL,
  ip TEXT,
  batch_id TEXT,
  pool_id BIGINT,
  customer_id BIGINT,
  asset TEXT,
  network TEXT,
  old_hash TEXT,
  new_hash TEXT,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pool_audit_created_idx ON pool_audit (created_at DESC);

CREATE OR REPLACE FUNCTION pool_audit_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pool_audit is append-only';
END;
$$;

DROP TRIGGER IF EXISTS pool_audit_no_mutate ON pool_audit;
CREATE TRIGGER pool_audit_no_mutate
  BEFORE UPDATE OR DELETE ON pool_audit
  FOR EACH ROW EXECUTE FUNCTION pool_audit_immutable();

ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'text';
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS card JSONB;

CREATE TABLE IF NOT EXISTS deposit_records (
  id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id),
  asset TEXT NOT NULL,
  network TEXT,
  amount TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirming', 'credited', 'flagged')),
  confirmations INT NOT NULL DEFAULT 0,
  required_confirmations INT NOT NULL DEFAULT 0,
  txid TEXT,
  source_address TEXT,
  bank_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deposit_records_user_idx ON deposit_records (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS deposit_records_txid_idx ON deposit_records (txid);
