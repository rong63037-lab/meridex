-- KYC: every customer submission waits for a human decision.
-- Additive only: existing rows keep their status; new columns record who decided and when.
ALTER TABLE kyc_profiles ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
ALTER TABLE kyc_profiles ADD COLUMN IF NOT EXISTS reviewed_by BIGINT REFERENCES users (id);
ALTER TABLE kyc_profiles ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE kyc_profiles ADD COLUMN IF NOT EXISTS review_note TEXT;
CREATE INDEX IF NOT EXISTS kyc_profiles_status_idx ON kyc_profiles (status);
