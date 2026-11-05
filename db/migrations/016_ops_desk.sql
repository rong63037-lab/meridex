-- Withdrawal review queue, and Malay help articles.
-- A pending row has already moved available -> withdraw_hold. Approve settles that hold.
-- Reject moves it back. The reference stays so the same request cannot be decided twice.

CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users (id),
  asset TEXT NOT NULL,
  network TEXT,
  address TEXT,
  gross_amount BIGINT NOT NULL CHECK (gross_amount > 0),
  fee_amount BIGINT NOT NULL CHECK (fee_amount >= 0),
  ledger_amount BIGINT NOT NULL CHECK (ledger_amount > 0),
  notional_uusd BIGINT NOT NULL CHECK (notional_uusd >= 0),
  source TEXT NOT NULL CHECK (source IN ('wallet', 'rail', 'crypto')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'posted')),
  reason TEXT,
  actor_id BIGINT REFERENCES users (id),
  hold_transfer_id TEXT,
  settle_transfer_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS withdrawal_requests_status_idx
  ON withdrawal_requests (status, created_at DESC);

ALTER TABLE help_articles ADD COLUMN IF NOT EXISTS title_ms TEXT;
ALTER TABLE help_articles ADD COLUMN IF NOT EXISTS body_ms TEXT;

UPDATE help_articles SET
  title_ms = 'Deposit demo',
  body_ms = 'Deposit di halaman dana guna landasan bank simulasi. Ia tidak bersambung ke bank sebenar.'
WHERE id = 'help-deposit';

UPDATE help_articles SET
  title_ms = 'Senarai putih pengeluaran',
  body_ms = 'Alamat baharu dikunci 24 jam. Pengeluaran ditolak sepanjang tempoh itu.'
WHERE id = 'help-whitelist';

UPDATE help_articles SET
  title_ms = 'Dagangan simulasi',
  body_ms = 'Baki simulasi tidak masuk lejar sebenar dan boleh ditetapkan semula.'
WHERE id = 'help-paper';

UPDATE help_articles SET
  title_ms = 'API terbuka',
  body_ms = 'Rahsia dipaparkan sekali sahaja. Skop lalai ialah read atau trade, bukan withdraw.'
WHERE id = 'help-api';
