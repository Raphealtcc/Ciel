-- CIEL D1 schema recovery snapshot
-- Exported read-only from Cloudflare D1 database "ciel" on 2026-11-01.
-- This captures current sqlite_master DDL. It does not represent original migration ordering.
-- Internal SQLite and Cloudflare _cf_KV tables are intentionally excluded.
-- Review this schema against app code before applying to a new database.

PRAGMA foreign_keys = ON;

-- table: advisor_ai_audit (table: advisor_ai_audit)
CREATE TABLE advisor_ai_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at_ms INTEGER NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL,
      model TEXT NOT NULL, verdict TEXT NOT NULL, reason TEXT NOT NULL, risk_flags TEXT NOT NULL,
      search_queries TEXT NOT NULL DEFAULT '[]', grounding_sources TEXT NOT NULL DEFAULT '[]'
    , forecast_json TEXT, market_context_json TEXT);

-- table: advisor_positions (table: advisor_positions)
CREATE TABLE advisor_positions (
      id TEXT PRIMARY KEY, symbol TEXT NOT NULL, side TEXT NOT NULL CHECK (side IN ('LONG','SHORT')),
      entry_price REAL NOT NULL, stop_price REAL NOT NULL, target_price REAL NOT NULL, stop_pct REAL NOT NULL, target_pct REAL NOT NULL,
      confidence REAL NOT NULL, strategy TEXT NOT NULL, rationale TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN',
      created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, mon_collateral REAL NOT NULL DEFAULT 10,
      leverage REAL NOT NULL DEFAULT 100, entry_mon_usd REAL NOT NULL, actual_entry_price REAL, manual_entry_at_ms INTEGER,
      exit_price REAL, exit_mon_usd REAL, closed_at_ms INTEGER, exit_reason TEXT, updated_at_ms INTEGER NOT NULL
    , tracking_started_at_ms INTEGER, tracking_entry_price REAL);

-- table: live_executions (table: live_executions)
CREATE TABLE live_executions (
        signal_id INTEGER PRIMARY KEY,
        execution_key TEXT NOT NULL UNIQUE,
        token_address TEXT NOT NULL,
        side TEXT NOT NULL,
        state TEXT NOT NULL,
        amount_mon REAL,
        quantity TEXT,
        quote_out TEXT,
        price_usd REAL,
        tx_hash TEXT,
        error TEXT,
        created_ts_ms INTEGER NOT NULL,
        updated_ts_ms INTEGER NOT NULL
      );

-- table: live_positions (table: live_positions)
CREATE TABLE live_positions (
        token_address TEXT PRIMARY KEY,
        quantity TEXT NOT NULL,
        entry_price_usd REAL,
        entry_ts_ms INTEGER,
        last_price_usd REAL,
        updated_ts_ms INTEGER NOT NULL
      );

-- table: market_alerts (table: market_alerts)
CREATE TABLE market_alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at_ms INTEGER NOT NULL, symbol TEXT NOT NULL, mid_price REAL NOT NULL, window_minutes INTEGER NOT NULL, change_pct REAL NOT NULL, return_5m_pct REAL, return_15m_pct REAL, return_60m_pct REAL);

-- table: market_book_snapshots (table: market_book_snapshots)
CREATE TABLE market_book_snapshots (
      symbol TEXT NOT NULL, ts_ms INTEGER NOT NULL, best_bid REAL NOT NULL, best_ask REAL NOT NULL,
      bid_size REAL NOT NULL DEFAULT 0, ask_size REAL NOT NULL DEFAULT 0, spread_bps REAL NOT NULL,
      PRIMARY KEY (symbol, ts_ms)
    );

-- table: market_candle_hourly_stats (table: market_candle_hourly_stats)
CREATE TABLE market_candle_hourly_stats (symbol TEXT NOT NULL, bucket_ms INTEGER NOT NULL, low_price REAL NOT NULL, high_price REAL NOT NULL, first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL, candle_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (symbol, bucket_ms));

-- table: market_candles (table: market_candles)
CREATE TABLE market_candles (
      symbol TEXT NOT NULL, interval TEXT NOT NULL, open_ts_ms INTEGER NOT NULL, close_ts_ms INTEGER NOT NULL,
      open_price REAL NOT NULL, high_price REAL NOT NULL, low_price REAL NOT NULL, close_price REAL NOT NULL,
      volume REAL NOT NULL DEFAULT 0, trade_count INTEGER NOT NULL DEFAULT 0, updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (symbol, interval, open_ts_ms)
    );

-- table: market_context_snapshots (table: market_context_snapshots)
CREATE TABLE market_context_snapshots (
  symbol TEXT NOT NULL, ts_ms INTEGER NOT NULL, mid_px REAL, mark_px REAL, oracle_px REAL,
  funding_rate REAL, open_interest REAL, day_ntl_volume REAL, previous_day_px REAL, premium REAL,
  PRIMARY KEY (symbol, ts_ms)
);

-- table: market_samples (table: market_samples)
CREATE TABLE market_samples (ts_ms INTEGER NOT NULL, symbol TEXT NOT NULL, mid_price REAL NOT NULL, PRIMARY KEY (symbol, ts_ms));

-- table: market_snapshots (table: market_snapshots)
CREATE TABLE market_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_address TEXT NOT NULL,
      ts_ms INTEGER NOT NULL,
      price_usd REAL,
      market_cap_usd REAL,
      liquidity_usd REAL,
      volume_5m_usd REAL,
      buys_5m INTEGER,
      sells_5m INTEGER,
      holders INTEGER,
      quote_token TEXT,
      buy_volume_usd REAL,
      sell_volume_usd REAL,
      source_block INTEGER
    );

-- table: paper_executions (table: paper_executions)
CREATE TABLE paper_executions (
      signal_id INTEGER PRIMARY KEY,
      execution_key TEXT NOT NULL UNIQUE,
      token_address TEXT NOT NULL,
      side TEXT NOT NULL,
      state TEXT NOT NULL,
      balance_before_mon REAL,
      balance_after_mon REAL,
      quantity TEXT,
      quote_out TEXT,
      fill_price_usd REAL,
      realized_pnl_usd REAL,
      position_quantity_after TEXT,
      error TEXT,
      created_ts_ms INTEGER NOT NULL,
      updated_ts_ms INTEGER NOT NULL
    );

-- table: positions (table: positions)
CREATE TABLE positions (
      token_address TEXT PRIMARY KEY,
      quantity TEXT NOT NULL,
      entry_price_usd REAL,
      entry_ts_ms INTEGER,
      last_price_usd REAL,
      updated_ts_ms INTEGER NOT NULL
    );

-- table: signals (table: signals)
CREATE TABLE signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_address TEXT NOT NULL,
      ts_ms INTEGER NOT NULL,
      action TEXT NOT NULL,
      confidence REAL,
      expected_low REAL,
      expected_high REAL,
      anomaly_score REAL,
      model TEXT,
      rationale TEXT,
      consumed_ts_ms INTEGER
    );

-- table: tokens (table: tokens)
CREATE TABLE tokens (
      address TEXT PRIMARY KEY,
      symbol TEXT,
      name TEXT,
      market_cap_usd REAL,
      liquidity_usd REAL,
      first_seen_ms INTEGER NOT NULL,
      last_seen_ms INTEGER NOT NULL,
      total_supply TEXT,
      decimals INTEGER NOT NULL DEFAULT 18,
      quote_token TEXT,
      pair_address TEXT,
      graduated INTEGER NOT NULL DEFAULT 0,
      created_at_block INTEGER
    );

-- table: trades (table: trades)
CREATE TABLE trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_address TEXT NOT NULL,
      ts_ms INTEGER NOT NULL,
      side TEXT NOT NULL,
      quantity TEXT,
      price_usd REAL,
      tx_hash TEXT,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      execution_key TEXT
    );

-- index: idx_advisor_ai_audit_created (table: advisor_ai_audit)
CREATE INDEX idx_advisor_ai_audit_created ON advisor_ai_audit (created_at_ms DESC);

-- index: idx_advisor_positions_status_created (table: advisor_positions)
CREATE INDEX idx_advisor_positions_status_created ON advisor_positions (status, created_at_ms DESC);

-- index: idx_advisor_positions_symbol_status (table: advisor_positions)
CREATE INDEX idx_advisor_positions_symbol_status ON advisor_positions (symbol, status);

-- index: idx_market_alerts_created (table: market_alerts)
CREATE INDEX idx_market_alerts_created ON market_alerts (created_at_ms DESC);

-- index: idx_market_alerts_symbol_created (table: market_alerts)
CREATE INDEX idx_market_alerts_symbol_created ON market_alerts (symbol, created_at_ms DESC);

-- index: idx_market_book_symbol_ts (table: market_book_snapshots)
CREATE INDEX idx_market_book_symbol_ts ON market_book_snapshots (symbol, ts_ms DESC);

-- index: idx_market_candles_symbol_interval_ts (table: market_candles)
CREATE INDEX idx_market_candles_symbol_interval_ts ON market_candles (symbol, interval, open_ts_ms DESC);

-- index: idx_market_context_symbol_ts (table: market_context_snapshots)
CREATE INDEX idx_market_context_symbol_ts ON market_context_snapshots(symbol, ts_ms DESC);

-- index: idx_market_samples_symbol_ts (table: market_samples)
CREATE INDEX idx_market_samples_symbol_ts ON market_samples (symbol, ts_ms DESC);

-- index: idx_market_snapshots_ts_token (table: market_snapshots)
CREATE INDEX idx_market_snapshots_ts_token ON market_snapshots(ts_ms, token_address, market_cap_usd);

-- index: idx_paper_executions_state (table: paper_executions)
CREATE INDEX idx_paper_executions_state ON paper_executions(state, updated_ts_ms);

-- index: idx_signals_unconsumed (table: signals)
CREATE INDEX idx_signals_unconsumed ON signals(consumed_ts_ms, ts_ms);

-- index: idx_snapshots_token_ts (table: market_snapshots)
CREATE INDEX idx_snapshots_token_ts ON market_snapshots(token_address, ts_ms);

-- index: idx_trades_execution_key (table: trades)
CREATE UNIQUE INDEX idx_trades_execution_key ON trades(execution_key) WHERE execution_key IS NOT NULL;

