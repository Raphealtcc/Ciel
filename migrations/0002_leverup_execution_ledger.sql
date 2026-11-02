CREATE TABLE IF NOT EXISTS leverup_preflight_snapshots (
  id TEXT PRIMARY KEY,
  signal_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  pair_base TEXT NOT NULL,
  checked_at_ms INTEGER NOT NULL,
  block_number TEXT,
  requested_leverage INTEGER NOT NULL CHECK (requested_leverage >= 50),
  market_max_leverage INTEGER NOT NULL CHECK (market_max_leverage >= 50),
  notional_usd_raw TEXT NOT NULL,
  oracle_price_raw TEXT NOT NULL,
  mon_usd_price_raw TEXT NOT NULL,
  collateral_ratio REAL NOT NULL,
  minimum_collateral_mon REAL NOT NULL,
  available_margin_mon REAL NOT NULL,
  fee_config_json TEXT NOT NULL,
  slippage_config_json TEXT NOT NULL,
  funding_rate_raw TEXT,
  holding_rate_long_raw TEXT,
  holding_rate_short_raw TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('PASS','REJECT')),
  rejection_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_leverup_preflight_signal ON leverup_preflight_snapshots(signal_id, checked_at_ms DESC);

CREATE TABLE IF NOT EXISTS leverup_position_fee_snapshots (
  position_hash TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  pair_base TEXT NOT NULL,
  symbol TEXT NOT NULL,
  is_long INTEGER NOT NULL,
  margin_token TEXT NOT NULL,
  open_fee_raw TEXT NOT NULL,
  execution_fee_raw TEXT NOT NULL,
  funding_fee_raw TEXT NOT NULL,
  holding_fee_raw TEXT NOT NULL,
  accrued_funding_fee_raw TEXT NOT NULL,
  accrued_holding_fee_raw TEXT NOT NULL,
  earliest_close_time INTEGER NOT NULL,
  source_block TEXT,
  PRIMARY KEY(position_hash, observed_at_ms)
);
CREATE INDEX IF NOT EXISTS idx_leverup_position_fee_latest ON leverup_position_fee_snapshots(position_hash, observed_at_ms DESC);

CREATE TABLE IF NOT EXISTS leverup_settlement_reconciliations (
  position_hash TEXT PRIMARY KEY,
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
