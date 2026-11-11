import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { reconcilePendingLeverUpIntents } from "../src/leverup-coordinator.js";

const worker = await readFile("reconstructed/patched-worker.js", "utf8");
const coordinator = await readFile("src/leverup-coordinator.js", "utf8");

assert.match(worker, /lookbackMinutes = needsBootstrap \? 210 : 15/);
assert.match(worker, /slice\(-240\)/);
assert.match(worker, /VENUE_MAX_LEVERAGE_BELOW_CONFIGURED_MINIMUM/);
assert.match(worker, /oneMinuteCandleCounts/);
assert.match(worker, /reviewCompletedAt: now/);
assert.match(worker, /this\\.coreScalpCandles = values\\[23\\] \\|\\| \\{\\}/);
assert.match(worker, /this\\.coreTrendCandles = values\\[24\\] \\|\\| \\{\\}/);
assert.match(worker, /this\\.lastHistoryBootstrapAt = Number\\(values\\[28\\]\\) \\|\\| 0/);
assert.doesNotMatch(worker, /this\\.coreScalpCandles = values\\[22\\]/);
assert.doesNotMatch(worker, /startTime:\s*now\s*-\s*75\s*\*\s*(?:60e3|6e4)/);

assert.match(coordinator, /payload_json IS NOT \?/);
assert.match(coordinator, /s\.position_hash = lower\(json_extract\(i\.payload_json, '\$\.positionHash'\)\)/);
assert.match(coordinator, /settledByPosition/);
assert.match(coordinator, /closeTimeSeconds/);
assert.match(coordinator, /position_hash = \\? AND close_time = \\?/);
assert.match(coordinator, /embeddedCloseTime === closeTimeSeconds/);
assert.match(coordinator, /settlement\?\.status \\|\\| ""\\)\\.toUpperCase\\(\\) !== "CLOSED"/);
assert.match(coordinator, /notificationTradeId/);
assert.match(coordinator, /now - lastCheck < 5 \* 60_000/);
assert.doesNotMatch(coordinator, /lastStatusCheckAt: now/);
assert.doesNotMatch(coordinator, /lastPositionCheckAt: now/);

const updates = [];
const pendingRow = {
  signal_id: "incident-test-pending",
  status: "PENDING",
  action: 0,
  intent_hash: "0x" + "1".repeat(64),
  payload_json: JSON.stringify({ executionPath: "1ct" }),
  pair_base: "0x" + "2".repeat(40),
  created_at_ms: 1,
};
const db = {
  prepare(sql) {
    if (sql.startsWith("SELECT * FROM leverup_execution_intents WHERE status IN ('SUBMITTED','PENDING')")) {
      return { all: async () => ({ results: [pendingRow] }) };
    }
    if (sql.startsWith("UPDATE leverup_execution_intents SET")) {
      return { bind: (...args) => ({ run: async () => { updates.push({ sql, args }); } }) };
    }
    throw new Error("Unexpected SQL in pending-intent test: " + sql);
  },
};
const result = await reconcilePendingLeverUpIntents({
  env: { LEVERUP_TRADER_ADDRESS: "0x" + "3".repeat(40) },
  db,
  now: 1_000_000,
  dependencies: {
    fetchOpenPositions: async () => [],
    getStatus: async () => ({ executed: false, success: null }),
  },
});
assert.equal(result.checked, 1);
assert.equal(updates.length, 0, "unchanged pending status checks must not write D1 rows");

console.log("CIEL incident repair checks passed.");
