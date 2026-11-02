-- Deposit concierge. Receiving details stay on the funds profile, never in chat.

ALTER TABLE users ADD COLUMN IF NOT EXISTS account_manager_id BIGINT REFERENCES users (id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS vip_desk BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS deposit_profiles (
  user_id BIGINT PRIMARY KEY REFERENCES users (id),
  reference_code TEXT NOT NULL UNIQUE,
  bank_name TEXT NOT NULL,
  bank_account TEXT NOT NULL,
  crypto_asset TEXT NOT NULL,
  crypto_address TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS topic TEXT;

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'general';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS callback_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS callback_lang TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS callback_phone TEXT;

CREATE TABLE IF NOT EXISTS agent_tasks (
  id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id),
  assignee_id BIGINT REFERENCES users (id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_tasks_status_idx ON agent_tasks (status, created_at DESC);
