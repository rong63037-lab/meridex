-- Multi-asset books. Gold rows keep the historical column names (qty_mg, price_cents):
-- those integers are the instrument's own scaled units, XAU still milligrams and cents/gram.

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'accounts' AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%asset%'
  LOOP
    EXECUTE format('ALTER TABLE accounts DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE order_holds ADD COLUMN IF NOT EXISTS symbol TEXT NOT NULL DEFAULT 'XAU/USD';
ALTER TABLE order_holds ADD COLUMN IF NOT EXISTS base_asset TEXT NOT NULL DEFAULT 'XAU';
ALTER TABLE order_holds ADD COLUMN IF NOT EXISTS quote_asset TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE order_holds ADD COLUMN IF NOT EXISTS qty_scale BIGINT NOT NULL DEFAULT 1000;
ALTER TABLE order_holds ADD COLUMN IF NOT EXISTS price_scale BIGINT NOT NULL DEFAULT 100;
ALTER TABLE order_holds ADD COLUMN IF NOT EXISTS quote_scale BIGINT NOT NULL DEFAULT 1000000;

ALTER TABLE user_orders ADD COLUMN IF NOT EXISTS symbol TEXT NOT NULL DEFAULT 'XAU/USD';
ALTER TABLE user_orders ADD COLUMN IF NOT EXISTS base_asset TEXT NOT NULL DEFAULT 'XAU';
ALTER TABLE user_orders ADD COLUMN IF NOT EXISTS quote_asset TEXT NOT NULL DEFAULT 'USD';

ALTER TABLE trades ADD COLUMN IF NOT EXISTS symbol TEXT NOT NULL DEFAULT 'XAU/USD';
ALTER TABLE trades ADD COLUMN IF NOT EXISTS base_asset TEXT NOT NULL DEFAULT 'XAU';
ALTER TABLE trades ADD COLUMN IF NOT EXISTS quote_asset TEXT NOT NULL DEFAULT 'USD';

CREATE INDEX IF NOT EXISTS trades_symbol_tape_idx ON trades (symbol, tape_at DESC);
CREATE INDEX IF NOT EXISTS user_orders_symbol_idx ON user_orders (symbol, status);

CREATE TABLE IF NOT EXISTS instruments (
  symbol TEXT PRIMARY KEY,
  name_zh TEXT NOT NULL,
  name_en TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('metal', 'crypto', 'commodity', 'fx')),
  base_asset TEXT NOT NULL,
  quote_asset TEXT NOT NULL,
  tick_size BIGINT NOT NULL,
  lot_size BIGINT NOT NULL,
  min_qty BIGINT NOT NULL,
  qty_scale BIGINT NOT NULL,
  price_scale BIGINT NOT NULL,
  price_decimals INT NOT NULL,
  qty_decimals INT NOT NULL,
  quote_scale BIGINT NOT NULL,
  band_bps INT NOT NULL,
  halt_bps INT NOT NULL,
  ref_price BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('trading', 'halted', 'pending')),
  jurisdictions TEXT[] NOT NULL,
  regulatory_tag TEXT NOT NULL,
  feed TEXT NOT NULL,
  networks TEXT[] NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS category_access (
  category TEXT NOT NULL,
  country TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('allow', 'pending', 'block')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (category, country)
);

CREATE TABLE IF NOT EXISTS category_audit (
  id BIGSERIAL PRIMARY KEY,
  category TEXT NOT NULL,
  country TEXT NOT NULL,
  previous_access TEXT,
  access TEXT NOT NULL,
  actor_user_id BIGINT,
  actor_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crypto_transfers (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id),
  asset TEXT NOT NULL,
  network TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('deposit', 'withdraw')),
  amount BIGINT NOT NULL,
  address TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  confirmations INT NOT NULL DEFAULT 0,
  required_confirmations INT NOT NULL DEFAULT 3,
  status TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crypto_transfers_user_idx ON crypto_transfers (user_id, created_at DESC);
