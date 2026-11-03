CREATE TABLE IF NOT EXISTS leverup_execution_intents (
  signal_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('PREPARED','SUBMITTED','PENDING','EXECUTED','SKIPPED','RECONCILED','REJECTED','UNCERTAIN')),
  intent_hash TEXT,
  pair_base TEXT,
  action INTEGER,
  requested_leverage INTEGER,
  margin_mon REAL,
  notional_usd REAL,
  payload_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_leverup_intents_status ON leverup_execution_intents(status, updated_at_ms);
CREATE TABLE IF NOT EXISTS leverup_portfolio_risk_snapshots (
  snapshot_at_ms INTEGER PRIMARY KEY,
  open_position_count INTEGER NOT NULL,
  aggregate_stop_risk_mon REAL NOT NULL,
  daily_realized_loss_mon REAL NOT NULL,
  rolling_drawdown_mon REAL NOT NULL,
  kill_switch_active INTEGER NOT NULL,
  source_json TEXT NOT NULL
);
