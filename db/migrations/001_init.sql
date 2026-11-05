-- Meridex M1 ledger. Amounts are integers: USD in micro-USD, gold in milligrams.
-- Every posting carries entity_id and the customer's jurisdiction.

CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  home_jurisdiction TEXT NOT NULL
);

INSERT INTO entities (id, display_name, home_jurisdiction) VALUES
  ('SG-OPCO', '新加坡运营公司', 'SG'),
  ('MY-ENTITY', '马来西亚实体（占位）', 'MY');

CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  totp_secret TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin', 'bot')),
  entity_id TEXT REFERENCES entities (id),
  jurisdiction TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE kyc_profiles (
  user_id BIGINT PRIMARY KEY REFERENCES users (id),
  nationality TEXT NOT NULL,
  residence_country TEXT NOT NULL,
  sanctions_hit BOOLEAN NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('approved', 'pending', 'rejected')),
  reason TEXT NOT NULL,
  entity_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE geo_alerts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users (id),
  ip TEXT,
  ip_country TEXT,
  residence_country TEXT,
  action TEXT NOT NULL CHECK (action IN ('alert', 'block')),
  path TEXT,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX geo_alerts_created_idx ON geo_alerts (created_at DESC);

CREATE TABLE accounts (
  id BIGSERIAL PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities (id),
  code TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('asset', 'liability')),
  asset TEXT NOT NULL CHECK (asset IN ('USD', 'XAU')),
  bucket TEXT NOT NULL,
  customer_id BIGINT REFERENCES users (id),
  jurisdiction TEXT,
  UNIQUE (entity_id, code)
);

CREATE INDEX accounts_customer_idx ON accounts (customer_id, asset, bucket);

CREATE TABLE balances (
  account_id BIGINT PRIMARY KEY REFERENCES accounts (id),
  amount BIGINT NOT NULL DEFAULT 0 CHECK (amount >= 0)
);

CREATE TABLE journal_entries (
  id BIGSERIAL PRIMARY KEY,
  transfer_id UUID NOT NULL,
  entity_id TEXT NOT NULL REFERENCES entities (id),
  kind TEXT NOT NULL,
  ref TEXT,
  actor_user_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX journal_entries_transfer_idx ON journal_entries (transfer_id);

CREATE TABLE postings (
  id BIGSERIAL PRIMARY KEY,
  entry_id BIGINT NOT NULL REFERENCES journal_entries (id),
  account_id BIGINT NOT NULL REFERENCES accounts (id),
  side TEXT NOT NULL CHECK (side IN ('debit', 'credit')),
  amount BIGINT NOT NULL CHECK (amount > 0),
  asset TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  jurisdiction TEXT NOT NULL
);

CREATE INDEX postings_entry_idx ON postings (entry_id);

CREATE TABLE order_holds (
  engine_order_id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id),
  entity_id TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  order_type TEXT NOT NULL,
  price_cents BIGINT,
  qty_mg BIGINT NOT NULL,
  leaves_mg BIGINT NOT NULL,
  filled_mg BIGINT NOT NULL DEFAULT 0,
  reserved_uusd BIGINT NOT NULL DEFAULT 0 CHECK (reserved_uusd >= 0),
  reserved_mg BIGINT NOT NULL DEFAULT 0 CHECK (reserved_mg >= 0),
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX order_holds_user_idx ON order_holds (user_id, status);

CREATE TABLE user_orders (
  engine_order_id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id),
  side TEXT NOT NULL,
  order_type TEXT NOT NULL,
  price_cents BIGINT,
  qty_mg BIGINT NOT NULL,
  leaves_mg BIGINT NOT NULL,
  filled_mg BIGINT NOT NULL DEFAULT 0,
  filled_notional_uusd BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  reject_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX user_orders_user_idx ON user_orders (user_id, created_at DESC);

CREATE TABLE trades (
  id BIGSERIAL PRIMARY KEY,
  engine_trade_id TEXT NOT NULL UNIQUE,
  price_cents BIGINT NOT NULL,
  qty_mg BIGINT NOT NULL,
  notional_uusd BIGINT NOT NULL,
  buyer_id BIGINT NOT NULL,
  seller_id BIGINT NOT NULL,
  buyer_entity TEXT NOT NULL,
  seller_entity TEXT NOT NULL,
  buyer_jurisdiction TEXT NOT NULL,
  seller_jurisdiction TEXT NOT NULL,
  taker_order_id TEXT NOT NULL,
  maker_order_id TEXT NOT NULL,
  taker_side TEXT NOT NULL,
  tape_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX trades_tape_idx ON trades (tape_at DESC);
CREATE INDEX trades_buyer_idx ON trades (buyer_id, tape_at DESC);
CREATE INDEX trades_seller_idx ON trades (seller_id, tape_at DESC);

CREATE TABLE activity (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id),
  kind TEXT NOT NULL,
  asset TEXT NOT NULL,
  amount BIGINT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX activity_user_idx ON activity (user_id, created_at DESC);

-- House and intercompany accounts. due_from is an asset, due_to is a liability.
INSERT INTO accounts (entity_id, code, account_type, asset, bucket, customer_id, jurisdiction) VALUES
  ('SG-OPCO', 'bank:USD', 'asset', 'USD', 'bank', NULL, 'SG'),
  ('SG-OPCO', 'vault:XAU', 'asset', 'XAU', 'vault', NULL, 'SG'),
  ('MY-ENTITY', 'bank:USD', 'asset', 'USD', 'bank', NULL, 'MY'),
  ('MY-ENTITY', 'vault:XAU', 'asset', 'XAU', 'vault', NULL, 'MY'),
  ('SG-OPCO', 'intercompany:MY-ENTITY:USD:due_to', 'liability', 'USD', 'due_to', NULL, 'SG'),
  ('SG-OPCO', 'intercompany:MY-ENTITY:USD:due_from', 'asset', 'USD', 'due_from', NULL, 'SG'),
  ('SG-OPCO', 'intercompany:MY-ENTITY:XAU:due_to', 'liability', 'XAU', 'due_to', NULL, 'SG'),
  ('SG-OPCO', 'intercompany:MY-ENTITY:XAU:due_from', 'asset', 'XAU', 'due_from', NULL, 'SG'),
  ('MY-ENTITY', 'intercompany:SG-OPCO:USD:due_to', 'liability', 'USD', 'due_to', NULL, 'MY'),
  ('MY-ENTITY', 'intercompany:SG-OPCO:USD:due_from', 'asset', 'USD', 'due_from', NULL, 'MY'),
  ('MY-ENTITY', 'intercompany:SG-OPCO:XAU:due_to', 'liability', 'XAU', 'due_to', NULL, 'MY'),
  ('MY-ENTITY', 'intercompany:SG-OPCO:XAU:due_from', 'asset', 'XAU', 'due_from', NULL, 'MY');

INSERT INTO balances (account_id, amount)
SELECT id, 0 FROM accounts;
