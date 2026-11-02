CREATE TABLE advisor_ai_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at_ms INTEGER NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL,
      model TEXT NOT NULL, verdict TEXT NOT NULL, reason TEXT NOT NULL, risk_flags TEXT NOT NULL,
      search_queries TEXT NOT NULL DEFAULT '[]', grounding_sources TEXT NOT NULL DEFAULT '[]'
    , forecast_json TEXT, market_context_json TEXT);

CREATE TABLE advisor_positions (
      id TEXT PRIMARY KEY, symbol TEXT NOT NULL, side TEXT NOT NULL CHECK (side IN ('LONG','SHORT')),
      entry_price REAL NOT NULL, stop_price REAL NOT NULL, target_price REAL NOT NULL, stop_pct REAL NOT NULL, target_pct REAL NOT NULL,
      confidence REAL NOT NULL, strategy TEXT NOT NULL, rationale TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN',
      created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, mon_collateral REAL NOT NULL DEFAULT 10,
      leverage REAL NOT NULL DEFAULT 100, entry_mon_usd REAL NOT NULL, actual_entry_price REAL, manual_entry_at_ms INTEGER,
      exit_price REAL, exit_mon_usd REAL, closed_at_ms INTEGER, exit_reason TEXT, updated_at_ms INTEGER NOT NULL
    , tracking_started_at_ms INTEGER, tracking_entry_price REAL);

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

CREATE TABLE live_positions (
        token_address TEXT PRIMARY KEY,
        quantity TEXT NOT NULL,
        entry_price_usd REAL,
        entry_ts_ms INTEGER,
        last_price_usd REAL,
        updated_ts_ms INTEGER NOT NULL
      );

CREATE TABLE market_alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at_ms INTEGER NOT NULL, symbol TEXT NOT NULL, mid_price REAL NOT NULL, window_minutes INTEGER NOT NULL, change_pct REAL NOT NULL, return_5m_pct REAL, return_15m_pct REAL, return_60m_pct REAL);

CREATE TABLE market_book_snapshots (
      symbol TEXT NOT NULL, ts_ms INTEGER NOT NULL, best_bid REAL NOT NULL, best_ask REAL NOT NULL,
      bid_size REAL NOT NULL DEFAULT 0, ask_size REAL NOT NULL DEFAULT 0, spread_bps REAL NOT NULL,
      PRIMARY KEY (symbol, ts_ms)
    );

CREATE TABLE market_candle_hourly_stats (symbol TEXT NOT NULL, bucket_ms INTEGER NOT NULL, low_price REAL NOT NULL, high_price REAL NOT NULL, first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL, candle_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (symbol, bucket_ms));

CREATE TABLE market_candles (
      symbol TEXT NOT NULL, interval TEXT NOT NULL, open_ts_ms INTEGER NOT NULL, close_ts_ms INTEGER NOT NULL,
      open_price REAL NOT NULL, high_price REAL NOT NULL, low_price REAL NOT NULL, close_price REAL NOT NULL,
      volume REAL NOT NULL DEFAULT 0, trade_count INTEGER NOT NULL DEFAULT 0, updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (symbol, interval, open_ts_ms)
    );

CREATE TABLE market_context_snapshots (
  symbol TEXT NOT NULL, ts_ms INTEGER NOT NULL, mid_px REAL, mark_px REAL, oracle_px REAL,
  funding_rate REAL, open_interest REAL, day_ntl_volume REAL, previous_day_px REAL, premium REAL,
  PRIMARY KEY (symbol, ts_ms)
);

CREATE TABLE market_samples (ts_ms INTEGER NOT NULL, symbol TEXT NOT NULL, mid_price REAL NOT NULL, PRIMARY KEY (symbol, ts_ms));

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

CREATE TABLE positions (
      token_address TEXT PRIMARY KEY,
      quantity TEXT NOT NULL,
      entry_price_usd REAL,
      entry_ts_ms INTEGER,
      last_price_usd REAL,
      updated_ts_ms INTEGER NOT NULL
    );

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

CREATE INDEX idx_advisor_ai_audit_created ON advisor_ai_audit (created_at_ms DESC);

CREATE INDEX idx_advisor_positions_status_created ON advisor_positions (status, created_at_ms DESC);

CREATE INDEX idx_advisor_positions_symbol_status ON advisor_positions (symbol, status);

CREATE INDEX idx_market_alerts_created ON market_alerts (created_at_ms DESC);

CREATE INDEX idx_market_alerts_symbol_created ON market_alerts (symbol, created_at_ms DESC);

CREATE INDEX idx_market_book_symbol_ts ON market_book_snapshots (symbol, ts_ms DESC);

CREATE INDEX idx_market_candles_symbol_interval_ts ON market_candles (symbol, interval, open_ts_ms DESC);

CREATE INDEX idx_market_context_symbol_ts ON market_context_snapshots(symbol, ts_ms DESC);

CREATE INDEX idx_market_samples_symbol_ts ON market_samples (symbol, ts_ms DESC);

CREATE INDEX idx_market_snapshots_ts_token ON market_snapshots(ts_ms, token_address, market_cap_usd);

CREATE INDEX idx_paper_executions_state ON paper_executions(state, updated_ts_ms);

CREATE INDEX idx_signals_unconsumed ON signals(consumed_ts_ms, ts_ms);

CREATE INDEX idx_snapshots_token_ts ON market_snapshots(token_address, ts_ms);

CREATE UNIQUE INDEX idx_trades_execution_key ON trades(execution_key) WHERE execution_key IS NOT NULL;
