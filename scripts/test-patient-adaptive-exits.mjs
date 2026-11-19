import assert from "node:assert/strict";
import { evaluateAdaptiveMarketPosition } from "../src/adaptive-market-position.js";

const samples = (prices) => prices.map((price, i) => ({ at: 1_000 + i * 60_000, price }));

// A healthy trend should not arm a tight trail on a small early move.
const earlyMove = evaluateAdaptiveMarketPosition({
  side: "LONG", entryPrice: 100, currentPrice: 102.2, stopPrice: 96, targetPrice: 0,
  state: { history: samples([100,100.3,100.6,100.9,101.2,101.5,101.8,102.2]), highWaterPrice: 102.2 },
  now: 481_000,
});
assert.equal(earlyMove.action, "HOLD");
assert.equal(earlyMove.reason, "ADAPTIVE_TREND_INTACT");

// Once armed, a healthy trend gets a wider ATR-based trail to avoid clipping
// ordinary pullbacks. The stop must still ratchet in the profitable direction.
const healthyTrail = evaluateAdaptiveMarketPosition({
  side: "LONG", entryPrice: 100, currentPrice: 103.4, stopPrice: 96, targetPrice: 0,
  state: { history: samples([102.8,102.9,103.0,103.1,103.2,103.3,103.4,103.5]), highWaterPrice: 103.5 },
  now: 481_000,
});
assert.equal(healthyTrail.action, "UPDATE_LEVELS");
assert.equal(healthyTrail.reason, "PATIENT_TREND_TRAILING_STOP");
assert.ok(healthyTrail.stopPrice > 100 && healthyTrail.stopPrice < 103.4);

// The same protection must work symmetrically for shorts.
const shortTrail = evaluateAdaptiveMarketPosition({
  side: "SHORT", entryPrice: 100, currentPrice: 96.6, stopPrice: 104, targetPrice: 0,
  state: { history: samples([97.2,97.1,97.0,96.9,96.8,96.7,96.6,96.5]), lowWaterPrice: 96.5 },
  now: 481_000,
});
assert.equal(shortTrail.action, "UPDATE_LEVELS");
assert.equal(shortTrail.reason, "PATIENT_TREND_TRAILING_STOP");
assert.ok(shortTrail.stopPrice < 100 && shortTrail.stopPrice > 96.6);

// A deteriorating move uses a tighter protective trail rather than the
// wider healthy-trend setting.
const weakeningTrail = evaluateAdaptiveMarketPosition({
  side: "LONG", entryPrice: 100, currentPrice: 103.0, stopPrice: 96, targetPrice: 0,
  state: { history: samples([103.5,103.4,103.3,103.2,103.1,103.0,103.1,103.0]), highWaterPrice: 103.5 },
  now: 481_000,
});
assert.equal(weakeningTrail.action, "UPDATE_LEVELS");
assert.equal(weakeningTrail.reason, "WEAKENING_TREND_PROTECTIVE_TRAIL");
assert.ok(weakeningTrail.stopPrice > 100 && weakeningTrail.stopPrice < 103.0);

// Emergency stops remain absolute and take priority over all adaptive logic.
const hardStop = evaluateAdaptiveMarketPosition({
  side: "SHORT", entryPrice: 100, currentPrice: 105, stopPrice: 104,
  state: { history: samples([100,99,98,97,96,97,98,99]) }, now: 481_000,
});
assert.equal(hardStop.action, "CLOSE");
assert.equal(hardStop.reason, "HARD_STOP_TRIGGERED");

console.log("PASS: patient trend trailing, weakening-trend protection, symmetric long/short exits and hard-stop priority");
