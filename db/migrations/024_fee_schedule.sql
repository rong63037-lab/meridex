-- Volume tiers for spot and USDS-margined perpetuals.
-- Rates are whole basis points (1 bp = 0.01%). Historical fills are not rewritten.

CREATE TABLE IF NOT EXISTS fee_tiers (
  product TEXT NOT NULL CHECK (product IN ('spot', 'perp')),
  tier INT NOT NULL CHECK (tier >= 0 AND tier <= 9),
  min_volume_uusd BIGINT NOT NULL,
  maker_bps INT NOT NULL,
  taker_bps INT NOT NULL,
  PRIMARY KEY (product, tier)
);

INSERT INTO fee_tiers (product, tier, min_volume_uusd, maker_bps, taker_bps) VALUES
  ('spot', 0, 0, 10, 10),
  ('spot', 1, 1000000000000, 9, 10),
  ('spot', 2, 5000000000000, 8, 10),
  ('spot', 3, 20000000000000, 4, 6),
  ('spot', 4, 75000000000000, 4, 5),
  ('perp', 0, 0, 2, 5),
  ('perp', 1, 15000000000000, 2, 4),
  ('perp', 2, 50000000000000, 1, 4),
  ('perp', 3, 100000000000000, 1, 3),
  ('perp', 4, 600000000000000, 1, 3)
ON CONFLICT (product, tier) DO UPDATE SET
  min_volume_uusd = EXCLUDED.min_volume_uusd,
  maker_bps = EXCLUDED.maker_bps,
  taker_bps = EXCLUDED.taker_bps;

UPDATE fee_schedules SET maker_bps = 10, taker_bps = 10, updated_at = now() WHERE vip_tier = 'standard';
UPDATE fee_schedules SET maker_bps = 9, taker_bps = 10, updated_at = now() WHERE vip_tier = 'silver';
UPDATE fee_schedules SET maker_bps = 8, taker_bps = 10, updated_at = now() WHERE vip_tier = 'gold';
UPDATE fee_schedules SET maker_bps = 4, taker_bps = 6, updated_at = now() WHERE vip_tier = 'private';

UPDATE vip_tiers SET min_volume_uusd = 0, min_hold_uusd = 0, maker_bps = 10, taker_bps = 10 WHERE id = 'standard';
UPDATE vip_tiers SET min_volume_uusd = 1000000000000, min_hold_uusd = 0, maker_bps = 9, taker_bps = 10 WHERE id = 'silver';
UPDATE vip_tiers SET min_volume_uusd = 5000000000000, min_hold_uusd = 0, maker_bps = 8, taker_bps = 10 WHERE id = 'gold';
UPDATE vip_tiers SET min_volume_uusd = 20000000000000, min_hold_uusd = 0, maker_bps = 4, taker_bps = 6 WHERE id = 'private';

ALTER TABLE trades ADD COLUMN IF NOT EXISTS buyer_fee_uusd BIGINT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS seller_fee_uusd BIGINT;
ALTER TABLE real_fills ADD COLUMN IF NOT EXISTS fee_uusd BIGINT;
