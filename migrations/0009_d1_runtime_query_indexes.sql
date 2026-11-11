-- Query indexes for CIEL2's high-frequency LeverUp and advisor lookups.
-- Expression indexes keep JSON-backed trade identity lookups bounded.
CREATE INDEX IF NOT EXISTS idx_advisor_ai_audit_symbol_model_created
  ON advisor_ai_audit(symbol, model, created_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_leverup_intents_action_trade_id_created
  ON leverup_execution_intents(action, json_extract(payload_json, '$.tradeId'), created_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_leverup_intents_action_position_hash_created
  ON leverup_execution_intents(action, lower(json_extract(payload_json, '$.positionHash')), created_at_ms DESC);
