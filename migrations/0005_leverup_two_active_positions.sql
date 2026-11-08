-- Replace the single-entry partial unique index with a hard two-entry concurrency guard.
-- Executed entry records remain active until the manager confirms the position is closed.
DROP INDEX IF EXISTS idx_leverup_one_active_entry;
CREATE INDEX IF NOT EXISTS idx_leverup_active_entries
ON leverup_execution_intents(action, status)
WHERE action = 0 AND status IN ('PREPARED','UNCERTAIN','SUBMITTED','PENDING','EXECUTED');
CREATE TRIGGER IF NOT EXISTS trg_leverup_max_two_active_entries
BEFORE INSERT ON leverup_execution_intents
WHEN NEW.action = 0
 AND (SELECT COUNT(*) FROM leverup_execution_intents
      WHERE action = 0 AND status IN ('PREPARED','UNCERTAIN','SUBMITTED','PENDING','EXECUTED')) >= 2
BEGIN
  SELECT RAISE(ABORT, 'LEVERUP_MAX_TWO_ACTIVE_ENTRIES');
END;
