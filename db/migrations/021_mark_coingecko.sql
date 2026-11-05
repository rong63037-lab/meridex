-- A fourth public spot source. Binance's ticker can return 451 from some locations.
-- CoinGecko, Coinbase, and Kraken still give a median when that happens.
-- No API key. Verify CoinGecko's terms before relying on this feed.

INSERT INTO lp_mark_sources (id, enabled, symbol_map, note) VALUES
  (
    'coingecko',
    true,
    '{"BTC/USD":"bitcoin","ETH/USD":"ethereum","SOL/USD":"solana","XRP/USD":"ripple"}'::jsonb,
    'Public simple price, no key. Verify CoinGecko terms before relying on this feed.'
  )
ON CONFLICT (id) DO NOTHING;
