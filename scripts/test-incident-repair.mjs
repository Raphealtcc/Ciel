import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { reconcilePendingLeverUpIntents } from "../src/leverup-coordinator.js";

const worker = await readFile("reconstructed/patched-worker.js", "utf8");
const coordinator = await readFile("src/leverup-coordinator.js", "utf8");

assert.ok(worker.includes("lookbackMinutes = needsBootstrap ? 210 : 15"));
assert.ok(worker.includes(".slice(-240)"));
assert.ok(worker.includes("WATCHLIST_ONLY_MAX_"));
assert.ok(worker.includes("oneMinuteCandleCounts"));
assert.ok(worker.includes("reviewCompletedAt: now"));
assert.ok(worker.includes("at least 61 distinct one-minute price buckets"), "forecast must require a real 60-minute context, not 180 arbitrary ticks");
assert.ok(worker.includes("const minuteBuckets = new Map()"), "high-frequency feed samples must be resampled by minute");
assert.ok(worker.includes("12e4 ? points[i].mid_price"), "anchor lookup must tolerate one missed one-minute bucket");

assert.ok(worker.includes("ciel:api:diagnostics:table-stats:v1"));
assert.ok(worker.includes("statsCacheNow - Number(cachedStats.at || 0) < 10 * 60 * 1e3"));
assert.ok(worker.includes("this.coreScalpCandles = values[23] || {};"));
const scalpWriter = worker.slice(worker.indexOf("async writeCoreScalpCandles(now)"), worker.indexOf("async writeHistory(rows, alerts, now)"));
assert.ok(scalpWriter.includes("filter((symbol) => Number(this.latest[symbol]) > 0)"));
assert.ok(!scalpWriter.includes("minLeverage"));
assert.ok(!scalpWriter.includes("LEVERUP_MARKET_MAX_LEVERAGE[symbol]"));
assert.ok(scalpWriter.includes('const symbols = ["BTC", "ETH", "SOL", "BNB", "HYPE", "ADA", "PUMP"]'));
assert.ok(scalpWriter.includes("CIEL_CORE_SCALP_1M_EMPTY"));
assert.ok(scalpWriter.includes("if (next.length !== existing.length || nextLast !== previousLast) updated = true;"));
assert.ok(worker.includes("this.coreTrendCandles = values[24] || {};"));
assert.ok(worker.includes("this.lastHistoryBootstrapAt = Number(values[28]) || 0;"));
assert.ok(!worker.includes("this.coreScalpCandles = values[22] || {};"));
assert.ok(!worker.includes("startTime: now - 75 * 60e3"));
assert.ok(!worker.includes("startTime: now - 75 * 6e4"));

assert.ok(coordinator.includes("payload_json IS NOT ?"));
assert.ok(coordinator.includes("json_extract(i.payload_json, '$.settlement.status') = 'CLOSED' AND EXISTS"));
assert.ok(coordinator.includes("settledByPosition"));
assert.ok(coordinator.includes("closeTimeSeconds"));
assert.ok(coordinator.includes("position_hash = ? AND close_time = ?"));
assert.ok(coordinator.includes("embeddedCloseTime === closeTimeSeconds"));
assert.ok(coordinator.includes('settlement?.status || "").toUpperCase() !== "CLOSED"'));
assert.ok(coordinator.includes("notificationTradeId"));
assert.ok(coordinator.includes("now - lastCheck < 5 * 60_000"));
assert.ok(!coordinator.includes("lastStatusCheckAt: now"));
assert.ok(!coordinator.includes("lastPositionCheckAt: now"));

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
