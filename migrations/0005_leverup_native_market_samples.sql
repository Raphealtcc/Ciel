CREATE TABLE IF NOT EXISTS leverup_market_samples (
  symbol TEXT NOT NULL,
  pair_base TEXT NOT NULL,
  price REAL NOT NULL CHECK(price > 0),
  observed_at_ms INTEGER NOT NULL,
  PRIMARY KEY(symbol, observed_at_ms)
);
CREATE INDEX IF NOT EXISTS idx_leverup_market_samples_time
  ON leverup_market_samples(observed_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_leverup_market_samples_symbol_time
  ON leverup_market_samples(symbol, observed_at_ms DESC);
