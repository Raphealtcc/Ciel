import assert from "node:assert/strict";
import { submitLeverUpIntent, evaluateLeverUpPositionAction, verifyLeverUpCoordinatorDryRun, reconcilePendingLeverUpIntents, refreshLeverUpMarketOpenPlan } from "../src/leverup-coordinator.js";

// Worst-case slippage must not push the executed notional above the leverage tier cap.
for (const isLong of [true, false]) {
  const notionalRaw = 20n * 10n ** 18n;
  const oracleRaw = 100n * 10n ** 18n;
  const refreshed = refreshLeverUpMarketOpenPlan({
    plan: {
      actionValues: ["0x" + "11".repeat(20), isLong, "0x" + "22".repeat(20), "0x" + "33".repeat(20), 1n, 1n, oracleRaw, 0n, 0n, 0, 0n],
      preflight: { notionalUsdRaw: notionalRaw.toString() },
    },
    pairView: { slippageConfig: { enabled: true, slippageType: 0, slippageLongP: 5, slippageShortP: 5 } },
    freshOraclePriceRaw: oracleRaw,
    entryPriceToleranceBps: 30,
    now: 1_800_000_000_000,
  });
  const worstNotionalRaw = BigInt(refreshed.qtyRaw) * BigInt(refreshed.worstPriceRaw) / (10n ** 10n);
  assert.ok(worstNotionalRaw <= notionalRaw, "slippage-adjusted notional must remain within the preflight tier ceiling");
  assert.ok(BigInt(refreshed.qtyRaw) < notionalRaw * (10n ** 10n) / oracleRaw,
    "quantity must be sized from worst-case execution price, not oracle mid");
}

class FakeD1 {
  rows = new Map();
  prepare(sql) {
    const db = this;
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      async run() {
        if (sql.startsWith("INSERT INTO leverup_execution_intents")) {
          const [signal_id,idempotency_key,pair_base,action,requested_leverage,margin_mon,notional_usd,payload_json,created_at_ms,updated_at_ms] = values;
          if (db.rows.has(signal_id) || [...db.rows.values()].some((r) => r.idempotency_key === idempotency_key)) throw new Error("UNIQUE constraint failed");
          db.rows.set(signal_id,{signal_id,idempotency_key,status:"PREPARED",pair_base,action,requested_leverage,margin_mon,notional_usd,payload_json,created_at_ms,updated_at_ms});
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("DELETE FROM leverup_execution_intents")) { db.rows.delete(values[0]); return { meta: { changes: 1 } }; }
        if (sql.startsWith("UPDATE leverup_execution_intents SET")) {
          const fields = [...sql.matchAll(/([a-z_]+) = \?/g)].map((m) => m[1]);
          const signalId = values[values.length - 1];
          const row = db.rows.get(signalId);
          if (!row) return { meta: { changes: 0 } };
          fields.forEach((field,i) => { row[field] = values[i]; });
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
      async first() {
        if (sql.includes("WHERE signal_id = ?")) return db.rows.get(values[0]) || null;
        if (sql.includes("WHERE idempotency_key = ?")) return [...db.rows.values()].find((r) => r.idempotency_key === values[0]) || null;
        return null;
      },
      async all() {
        if (sql.includes("WHERE status IN ('SUBMITTED','PENDING')")) return { results: [...db.rows.values()].filter((r) => ["SUBMITTED","PENDING"].includes(r.status) && r.intent_hash) };
        return { results: [] };
      },
    };
  }
}
const db = new FakeD1();
let approvalCalls = 0, submitCalls = 0;
const env = { LEVERUP_LIVE_TRADING: "true", LEVERUP_KILL_SWITCH: "false", LEVERUP_AGENT_PRIVATE_KEY: "test-only" };
const args = {
  env, db, signalId: "ciel-signal-001", action: 0,
  actionValues: ["0x" + "11".repeat(20), true, "0x" + "22".repeat(20), "0x" + "33".repeat(20), 1n, 1n, 1n, 0n, 0n, 0, 0n],
  traderAddress: "0x" + "44".repeat(20), agentAddress: "0x" + "55".repeat(20),
  agentAuthorization: { authorized: true, agentAddress: "0x" + "55".repeat(20), canMarketOpen: true },
  nonce: "1", deadline: Math.floor(Date.now()/1000)+300, feeToken: "0x" + "00".repeat(20),
  allowanceRequirements: [{ tokenAddress: "0x" + "22".repeat(20), amount: 5n }],
  preflight: { preflightPassed: true, status: "AVAILABLE", requestedLeverage: 100, marketMaxLeverage: 100, maxLeverageForNotional: 100, pairBase: "0x" + "11".repeat(20), checkedAt: Date.now() },
  dependencies: {
    ensureAllowance: async () => { approvalCalls++; return { status: "APPROVED" }; },
    readTokenBalancesAndAllowances: async (_trader, tokens) => Object.fromEntries(tokens.map((token) => [
      token.toLowerCase(), { balance: 5n, allowance: 5n },
    ])),
    submit: async () => { submitCalls++; return { intentHash: "0x" + "ab".repeat(32), intent: { actionDataHash: "0x" + "cd".repeat(32) } }; },
  },
};
const blocked = await submitLeverUpIntent({ ...args, env: { ...env, LEVERUP_LIVE_TRADING: "false" } });
assert.equal(blocked.status, "LIVE_DISABLED");
assert.equal(approvalCalls, 0);
assert.equal(submitCalls, 0);
const first = await submitLeverUpIntent(args);
assert.equal(first.status, "SUBMITTED");
assert.equal(first.submitted, true);
assert.equal(approvalCalls, 1);
assert.equal(submitCalls, 1);
assert.equal(db.rows.get(args.signalId).status, "SUBMITTED");
assert.equal(db.rows.get(args.signalId).intent_hash, "0x" + "ab".repeat(32));
const duplicate = await submitLeverUpIntent(args);
assert.equal(duplicate.duplicate, true);
assert.equal(approvalCalls, 1);
assert.equal(submitCalls, 1);

const failedReconciliation = await reconcilePendingLeverUpIntents({
  env, db, now: Date.now(),
  dependencies: {
    getStatus: async () => ({ executed: true, success: false, skipped: false, reason: "Unable to trade at a price acceptable to the user." }),
    fetchOpenPositions: async () => [],
  },
});
assert.equal(failedReconciliation.rejected, 1);
assert.equal(db.rows.get(args.signalId).status, "REJECTED");
assert.match(db.rows.get(args.signalId).last_error, /price acceptable/);

const position = {
  positionHash: "0x" + "aa".repeat(32), qtyRaw: "1000", entryPriceRaw: "100000000000000000000",
  stopLossRaw: "99000000000000000000", takeProfitRaw: "101000000000000000000",
  isLong: true, earliestCloseTime: "0", timestamp: Math.floor(Date.now()/1000)-60,
};
const partial = evaluateLeverUpPositionAction({
  position, currentPriceRaw: "100400000000000000000", now: Date.now(),
  partialTakeProfits: [{ targetPct: 0.3, closePct: 40 }],
});
assert.equal(partial.action, "PARTIAL_CLOSE");
assert.equal(partial.qtyRaw, "400");
const finalTarget = evaluateLeverUpPositionAction({
  position, currentPriceRaw: "101000000000000000000", now: Date.now(),
  partialTakeProfits: [{ targetPct: 0.3, closePct: 40 }], completedPartialLevels: [0],
});
assert.equal(finalTarget.action, "MARKET_CLOSE");
assert.equal(finalTarget.reason, "TAKE_PROFIT_TRIGGERED");
const stopped = evaluateLeverUpPositionAction({ position, currentPriceRaw: "98000000000000000000", now: Date.now() });
assert.equal(stopped.action, "MARKET_CLOSE");
assert.equal(stopped.reason, "STOP_LOSS_TRIGGERED");
const held = evaluateLeverUpPositionAction({
  position: { ...position, earliestCloseTime: String(Math.floor(Date.now()/1000)+300) },
  currentPriceRaw: "100000000000000000000", now: Date.now(),
});
assert.equal(held.action, "WAIT");
console.log("PASS: hard-off gate, unique D1 idempotency claim, exact approval hook, one submit only, partial TP sizing, stop/target and min-hold exit logic.");

const dryRunLedger = await verifyLeverUpCoordinatorDryRun({
  env: { LEVERUP_LIVE_TRADING: "false", LEVERUP_KILL_SWITCH: "true" },
  db, now: Date.now(),
});
assert.equal(dryRunLedger.status, "PASS");
assert.equal(dryRunLedger.orderSubmitted, false);
assert.equal(dryRunLedger.intentClaimed, true);
assert.equal(dryRunLedger.duplicateBlocked, true);
assert.equal(dryRunLedger.statusReconciled, true);
assert.equal(db.rows.size, 1, "diagnostic intent must be deleted after verification; only the original lifecycle test row remains");
