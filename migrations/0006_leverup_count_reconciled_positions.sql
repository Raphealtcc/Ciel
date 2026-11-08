-- Reconciled entry rows can still represent open CIEL-owned positions.
-- Keep them in the two-position cap until an on-chain read marks them CLOSED.
DROP INDEX IF EXISTS idx_leverup_active_entries;
DROP TRIGGER IF EXISTS trg_leverup_max_two_active_entries;
CREATE INDEX IF NOT EXISTS idx_leverup_active_entries
ON leverup_execution_intents(action, status)
WHERE action = 0 AND status IN ('PREPARED','UNCERTAIN','SUBMITTED','PENDING','EXECUTED','RECONCILED');
CREATE TRIGGER IF NOT EXISTS trg_leverup_max_two_active_entries
BEFORE INSERT ON leverup_execution_intents
WHEN NEW.action = 0
 AND (SELECT COUNT(*) FROM leverup_execution_intents
      WHERE action = 0 AND status IN ('PREPARED','UNCERTAIN','SUBMITTED','PENDING','EXECUTED','RECONCILED')) >= 2
BEGIN
  SELECT RAISE(ABORT, 'LEVERUP_MAX_TWO_ACTIVE_ENTRIES');
END;
