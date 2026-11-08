-- Keep the existing constrained status vocabulary. A reconciled row with closedAt
-- is terminal for concurrency/management, while still available to settlement reconciliation.
DROP INDEX IF EXISTS idx_leverup_active_entries;
DROP TRIGGER IF EXISTS trg_leverup_max_two_active_entries;
CREATE INDEX IF NOT EXISTS idx_leverup_active_entries
ON leverup_execution_intents(action, status)
WHERE action = 0 AND status IN ('PREPARED','UNCERTAIN','SUBMITTED','PENDING','EXECUTED','RECONCILED');
CREATE TRIGGER IF NOT EXISTS trg_leverup_max_two_active_entries
BEFORE INSERT ON leverup_execution_intents
WHEN NEW.action = 0
 AND (SELECT COUNT(*) FROM leverup_execution_intents
      WHERE action = 0
        AND status IN ('PREPARED','UNCERTAIN','SUBMITTED','PENDING','EXECUTED','RECONCILED')
        AND (status != 'RECONCILED' OR json_extract(payload_json,'$.closedAt') IS NULL)) >= 2
BEGIN
  SELECT RAISE(ABORT, 'LEVERUP_MAX_TWO_ACTIVE_ENTRIES');
END;
