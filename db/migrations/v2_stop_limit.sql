-- Migration v2: Add stop_price and take_profit_price to recommendations
-- Run against the remote D1 database:
--   npx wrangler d1 execute insider-trader --remote --file=db/migrations/v2_stop_limit.sql

ALTER TABLE recommendations ADD COLUMN stop_price REAL;
ALTER TABLE recommendations ADD COLUMN take_profit_price REAL;
