CREATE UNIQUE INDEX IF NOT EXISTS idx_leverup_one_active_entry
ON leverup_execution_intents(action)
WHERE action = 0 AND status IN ('PREPARED','UNCERTAIN','SUBMITTED','PENDING','EXECUTED');
