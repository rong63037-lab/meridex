-- Manual deposit credits. The reference is unique per asset so one txid cannot be posted twice.
-- Reversal keeps the row, so the reference stays consumed.

CREATE TABLE IF NOT EXISTS manual_deposits (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id),
  asset TEXT NOT NULL,
  network TEXT NOT NULL,
  gross_amount BIGINT NOT NULL CHECK (gross_amount > 0),
  fee_amount BIGINT NOT NULL CHECK (fee_amount >= 0),
  net_amount BIGINT NOT NULL CHECK (net_amount > 0),
  decimals INT NOT NULL,
  reference TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  note TEXT,
  screenshot_url TEXT,
  actor_id BIGINT NOT NULL REFERENCES users (id),
  transfer_id TEXT NOT NULL,
  claim_id BIGINT,
  flagged BOOLEAN NOT NULL DEFAULT false,
  reversed_at TIMESTAMPTZ,
  reverse_transfer_id TEXT,
  reverse_actor_id BIGINT REFERENCES users (id),
  reverse_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (gross_amount = net_amount + fee_amount)
);

CREATE UNIQUE INDEX IF NOT EXISTS manual_deposits_asset_ref_uq
  ON manual_deposits (asset, lower(reference));

CREATE INDEX IF NOT EXISTS manual_deposits_created_idx
  ON manual_deposits (created_at DESC);

CREATE TABLE IF NOT EXISTS deposit_claims (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id),
  asset TEXT NOT NULL,
  network TEXT NOT NULL,
  amount TEXT NOT NULL,
  reference TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'credited', 'dismissed')),
  manual_deposit_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deposit_claims_user_idx
  ON deposit_claims (user_id, status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS deposit_claims_pending_ref
  ON deposit_claims (user_id, asset, lower(reference))
  WHERE status = 'pending';

INSERT INTO surv_rules (id, title_zh, title_en, threshold, window_sec, enabled)
VALUES ('large_manual_deposit', '大额手工入账', 'Large manual deposit', 10000, 86400, true)
ON CONFLICT (id) DO NOTHING;
