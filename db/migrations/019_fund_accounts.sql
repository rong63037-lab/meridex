-- Stable funds account id, staff notes, and the withdrawal "sent" mark.
-- fund_id is MXF- plus 8 hex digits of the user id. It does not change.
-- Marking a withdrawal sent does not move the ledger. Approve already settled the hold.

ALTER TABLE users ADD COLUMN IF NOT EXISTS fund_id TEXT;

UPDATE users
SET fund_id = 'MXF-' || lpad(upper(to_hex(id)), 8, '0')
WHERE fund_id IS NULL;

ALTER TABLE users ALTER COLUMN fund_id SET NOT NULL;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_fund_id_format;
ALTER TABLE users ADD CONSTRAINT users_fund_id_format CHECK (fund_id ~ '^MXF-[0-9A-F]{8}$');

CREATE UNIQUE INDEX IF NOT EXISTS users_fund_id_uq ON users (fund_id);

CREATE OR REPLACE FUNCTION users_assign_fund_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.fund_id IS NULL OR btrim(NEW.fund_id) = '' THEN
    IF NEW.id IS NULL THEN
      NEW.id := nextval(pg_get_serial_sequence('users', 'id'));
    END IF;
    NEW.fund_id := 'MXF-' || lpad(upper(to_hex(NEW.id)), 8, '0');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_fund_id_bi ON users;
CREATE TRIGGER users_fund_id_bi
BEFORE INSERT ON users
FOR EACH ROW
EXECUTE FUNCTION users_assign_fund_id();

CREATE TABLE IF NOT EXISTS staff_notes (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id),
  actor_id BIGINT NOT NULL REFERENCES users (id),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS staff_notes_user_idx ON staff_notes (user_id, id DESC);

ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS tx_hash TEXT;
ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS sent_actor_id BIGINT REFERENCES users (id);
