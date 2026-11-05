-- Each order book numbers its own trades from 1. Identity is the book plus that id.
ALTER TABLE trades DROP CONSTRAINT IF EXISTS trades_engine_trade_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS trades_symbol_engine_trade_idx ON trades (symbol, engine_trade_id);
