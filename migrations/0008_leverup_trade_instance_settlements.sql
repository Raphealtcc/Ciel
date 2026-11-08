-- Trade-instance settlement ledger. Keep the legacy hash-keyed table intact for historical compatibility.
CREATE TABLE IF NOT EXISTS leverup_trade_settlements (
  trade_id TEXT PRIMARY KEY,
  position_hash TEXT NOT NULL,
  symbol TEXT NOT NULL,
  close_time INTEGER NOT NULL,
  close_price_raw TEXT NOT NULL,
  gross_pnl_raw TEXT NOT NULL,
  open_fee_raw TEXT NOT NULL,
  close_fee_raw TEXT NOT NULL,
  funding_fee_raw TEXT NOT NULL,
  holding_fee_raw TEXT NOT NULL,
  total_net_costs_raw TEXT NOT NULL,
  net_pnl_after_fees_raw TEXT NOT NULL,
  funding_since_last_snapshot_raw TEXT,
  holding_since_last_snapshot_raw TEXT,
  reconciled_at_ms INTEGER NOT NULL,
  source_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leverup_trade_settlements_close_time
ON leverup_trade_settlements(close_time DESC);
CREATE INDEX IF NOT EXISTS idx_leverup_trade_settlements_position_hash
ON leverup_trade_settlements(position_hash, close_time DESC);
