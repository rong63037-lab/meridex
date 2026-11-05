-- OHLC history for the terminal. Prices are the instrument's integer units.
-- volume_qty is base quantity in those units. volume_quote is micro-units of the quote asset.

CREATE TABLE IF NOT EXISTS candles (
  symbol TEXT NOT NULL,
  tf TEXT NOT NULL,
  open_time TIMESTAMPTZ NOT NULL,
  open_px BIGINT NOT NULL,
  high_px BIGINT NOT NULL,
  low_px BIGINT NOT NULL,
  close_px BIGINT NOT NULL,
  volume_qty BIGINT NOT NULL,
  volume_quote BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (symbol, tf, open_time)
);

CREATE INDEX IF NOT EXISTS candles_tf_time_idx ON candles (tf, open_time);

CREATE TABLE IF NOT EXISTS candle_sources (
  symbol TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
