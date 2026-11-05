-- Test-environment liquidity adapters. All stay off.
-- Secrets are not stored here. The gateway reads ~/.meridex-secrets/*.env.

INSERT INTO lp_providers (name, type, base_url, secret_ref, enabled, mode, priority, symbol_map)
VALUES
  (
    'binance-demo',
    'rest',
    'https://demo-fapi.binance.com',
    '',
    false,
    'off',
    40,
    '{"BTC/USD":"BTCUSDT","ETH/USD":"ETHUSDT"}'::jsonb
  ),
  (
    'saxo-sim',
    'rest',
    'https://gateway.saxobank.com/sim/openapi',
    '',
    false,
    'off',
    50,
    '{"EUR/USD":"FxSpot:21"}'::jsonb
  ),
  (
    'coinbase-sandbox',
    'rest',
    'https://api-public.sandbox.exchange.coinbase.com',
    '',
    false,
    'off',
    60,
    '{}'::jsonb
  )
ON CONFLICT (name) DO NOTHING;
