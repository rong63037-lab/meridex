-- Risk, security, operations, API keys, growth, support. Ledger tables are untouched.

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'users' AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%role%'
  LOOP
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('customer', 'admin', 'bot', 'risk', 'ops', 'support'));

ALTER TABLE users ADD COLUMN IF NOT EXISTS frozen BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS freeze_reason TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phishing_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by BIGINT REFERENCES users (id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS points BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_tier TEXT NOT NULL DEFAULT 'basic';

CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_idx ON users (referral_code) WHERE referral_code IS NOT NULL;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device_label TEXT;

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scopes TEXT NOT NULL DEFAULT 'read';
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS ip_whitelist TEXT;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS secret_sandbox TEXT;

ALTER TABLE notification_prefs ADD COLUMN IF NOT EXISTS email_on BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE notification_prefs ADD COLUMN IF NOT EXISTS sms_on BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE notification_prefs ADD COLUMN IF NOT EXISTS push_on BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS withdrawal_addresses (
  id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id),
  asset TEXT NOT NULL,
  address TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL CHECK (status IN ('locked', 'active', 'removed')),
  unlock_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS withdrawal_addresses_user_idx ON withdrawal_addresses (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS security_events (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users (id),
  kind TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS password_breaches (
  prefix TEXT NOT NULL,
  suffix TEXT NOT NULL,
  PRIMARY KEY (prefix, suffix)
);

CREATE TABLE IF NOT EXISTS surv_rules (
  id TEXT PRIMARY KEY,
  title_zh TEXT NOT NULL,
  title_en TEXT NOT NULL,
  threshold INT NOT NULL,
  window_sec INT NOT NULL DEFAULT 60,
  enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS surv_events (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  kind TEXT NOT NULL,
  symbol TEXT,
  notional_uusd BIGINT,
  ref_bps INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS surv_events_user_idx ON surv_events (user_id, kind, created_at DESC);

CREATE TABLE IF NOT EXISTS surv_alerts (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  user_id BIGINT REFERENCES users (id),
  symbol TEXT,
  severity TEXT NOT NULL,
  demo BOOLEAN NOT NULL DEFAULT false,
  detail TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS surv_alerts_created_idx ON surv_alerts (created_at DESC);

CREATE TABLE IF NOT EXISTS risk_cases (
  id TEXT PRIMARY KEY,
  alert_id TEXT REFERENCES surv_alerts (id),
  subject_user_id BIGINT REFERENCES users (id),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'assigned', 'closed')),
  assignee_id BIGINT REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS risk_case_notes (
  id BIGSERIAL PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES risk_cases (id),
  actor_id BIGINT REFERENCES users (id),
  body TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS change_requests (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  maker_id BIGINT NOT NULL REFERENCES users (id),
  checker_id BIGINT REFERENCES users (id),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS fee_schedules (
  vip_tier TEXT PRIMARY KEY,
  maker_bps INT NOT NULL,
  taker_bps INT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  banner BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  reward_points INT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reward_tasks (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  title_zh TEXT NOT NULL,
  title_en TEXT NOT NULL,
  points INT NOT NULL,
  needs_approval BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS user_tasks (
  user_id BIGINT NOT NULL REFERENCES users (id),
  task_id TEXT NOT NULL REFERENCES reward_tasks (id),
  status TEXT NOT NULL,
  PRIMARY KEY (user_id, task_id)
);

CREATE TABLE IF NOT EXISTS referrals (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  inviter_id BIGINT NOT NULL REFERENCES users (id),
  invitee_id BIGINT NOT NULL REFERENCES users (id),
  commission_uusd BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (invitee_id)
);

CREATE TABLE IF NOT EXISTS vip_tiers (
  id TEXT PRIMARY KEY,
  min_volume_uusd BIGINT NOT NULL,
  min_hold_uusd BIGINT NOT NULL,
  maker_bps INT NOT NULL,
  taker_bps INT NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id),
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'pending', 'closed')),
  assignee_id BIGINT REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id BIGSERIAL PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets (id),
  author_id BIGINT REFERENCES users (id),
  body TEXT NOT NULL,
  staff BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id),
  author_id BIGINT REFERENCES users (id),
  body TEXT NOT NULL,
  staff BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_messages_user_idx ON chat_messages (user_id, id DESC);

CREATE TABLE IF NOT EXISTS help_articles (
  id TEXT PRIMARY KEY,
  title_zh TEXT NOT NULL,
  title_en TEXT NOT NULL,
  body_zh TEXT NOT NULL,
  body_en TEXT NOT NULL,
  tags TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'push', 'inapp')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  phishing_code TEXT,
  provider TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notification_outbox_user_idx ON notification_outbox (user_id, created_at DESC);
