import assert from "node:assert/strict";
import { evaluateAdaptiveMarketPosition } from "../src/adaptive-market-position.js";
import {
  normalizePositionReversalQueue,
  reconcilePositionReversalQueue,
  matchPositionReversalRequest,
  updatePositionReversalRequest,
} from "../src/position-reversal-queue.js";

const samples = (prices, start = 1_000) => prices.map((price, i) => ({ at: start + i * 60_000, price }));
const extension = evaluateAdaptiveMarketPosition({
  side: "LONG", entryPrice: 100, currentPrice: 103.1, stopPrice: 98.8, targetPrice: 103,
  state: { history: samples([100, 100.2, 100.4, 100.7, 101, 101.4, 101.8, 102.2, 102.7, 103]), highWaterPrice: 103 },
  now: 601_000,
});
assert.equal(extension.action, "UPDATE_LEVELS");
assert.equal(extension.reason, "TREND_CONTINUATION_TARGET_EXTENSION");
assert.ok(extension.targetPrice > 103);
assert.equal(extension.state.targetExtended, true);

const noSecondExtension = evaluateAdaptiveMarketPosition({
  side: "LONG", entryPrice: 100, currentPrice: 103.2, stopPrice: 98.8, targetPrice: extension.targetPrice,
  state: { ...extension.state, targetExtended: true }, now: 661_000,
});
assert.notEqual(noSecondExtension.reason, "TREND_CONTINUATION_TARGET_EXTENSION");

const reversal = evaluateAdaptiveMarketPosition({
  side: "LONG", entryPrice: 100, currentPrice: 104, stopPrice: 97, targetPrice: 108,
  state: { history: samples([110, 109, 108, 107, 106, 105, 104.8, 104.5, 104.2]), highWaterPrice: 110, peakFavourablePct: 10 },
  now: 541_000,
});
assert.equal(reversal.action, "CLOSE");
assert.equal(reversal.reason, "ADAPTIVE_PROFIT_REVERSAL");
assert.equal(reversal.reverseConfirmed, true);

const adverse = evaluateAdaptiveMarketPosition({
  side: "LONG", entryPrice: 100, currentPrice: 98.8, stopPrice: 97, targetPrice: 105,
  state: { history: samples([100, 99.8, 99.6, 99.4, 99.2, 99, 98.9]), highWaterPrice: 100 },
  now: 421_000,
});
assert.equal(adverse.action, "CLOSE");
assert.equal(adverse.reason, "ADAPTIVE_ADVERSE_CUT");

const recovery = evaluateAdaptiveMarketPosition({
  side: "LONG", entryPrice: 100, currentPrice: 98.7, stopPrice: 97, targetPrice: 105,
  state: { history: samples([100, 99.5, 99, 98.5, 98.3, 98.4, 98.6]), highWaterPrice: 100 },
  now: 421_000,
});
assert.notEqual(recovery.reason, "ADAPTIVE_ADVERSE_CUT");

const queue = [{ id: "live:old", status: "WAITING_CLOSE_CONFIRMATION", positionHash: "0xold", symbol: "BTC", side: "SHORT", requestedAt: 1, expiresAt: 999_999 }];
const stillOpen = reconcilePositionReversalQueue(queue, [{ positionHash: "0xold", symbol: "BTC", side: "LONG" }], 10_000);
assert.equal(stillOpen.queue[0].status, "WAITING_CLOSE_CONFIRMATION");
const closed = reconcilePositionReversalQueue(queue, [], 20_000);
assert.equal(closed.queue[0].status, "CLOSE_CONFIRMED");
const request = matchPositionReversalRequest(closed.queue, { symbol: "BTC", side: "SHORT" }, 20_000);
assert.equal(request.id, "live:old");
assert.equal(matchPositionReversalRequest(closed.queue, { symbol: "BTC", side: "LONG" }, 20_000), null);

const submitted = updatePositionReversalRequest(closed.queue, "live:old", { status: "ENTRY_SUBMITTED", entrySignalId: "new-entry" }, 30_000);
const wrongEntry = reconcilePositionReversalQueue(submitted.queue, [{ symbol: "BTC", side: "SHORT", signalId: "unrelated" }], 40_000);
assert.equal(wrongEntry.queue[0].status, "ENTRY_SUBMITTED");
const correctEntry = reconcilePositionReversalQueue(submitted.queue, [{ symbol: "BTC", side: "SHORT", signalId: "new-entry" }], 50_000);
assert.equal(correctEntry.queue[0].status, "COMPLETED");
assert.equal(normalizePositionReversalQueue([{ ...queue[0], expiresAt: 1 }], 2).length, 0);

console.log("PASS: trend extension, hard stops, adaptive reversal, early adverse cuts and verified reversal queue");
