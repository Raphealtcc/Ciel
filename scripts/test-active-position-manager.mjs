import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { evaluateAdaptiveMarketPosition } from "../src/adaptive-market-position.js";
import { hyperliquidPriceRawForPosition, selectLeverUpPositionAction } from "../src/leverup-coordinator.js";
import {
  normalizePositionReversalQueue,
  reconcilePositionReversalQueue,
  matchPositionReversalRequest,
  updatePositionReversalRequest,
} from "../src/position-reversal-queue.js";

const samples = (prices, start = 1_000) => prices.map((price, i) => ({ at: start + i * 60_000, price }));
assert.equal(hyperliquidPriceRawForPosition({ symbol: "BTC" }, [{ symbol: "BTC", price: 65000 }]), "65000000000000000000000");
assert.equal(hyperliquidPriceRawForPosition({ symbol: "ETH-USD" }, [{ coin: "ETH", mid: "3000.5" }]), "3000500000000000000000");
assert.equal(hyperliquidPriceRawForPosition({ symbol: "UNKNOWN" }, [{ symbol: "BTC", price: 65000 }]), null);
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
  state: { history: samples([110,109,108,107,106,105,104.8,104.5,104.2,104.1,104.05]), highWaterPrice: 110, peakFavourablePct: 10 },
  now: 661_000,
});
assert.equal(reversal.action, "CLOSE");
assert.equal(reversal.reason, "ADAPTIVE_PROFIT_REVERSAL");
assert.equal(reversal.reverseConfirmed, true);

const adverse = evaluateAdaptiveMarketPosition({
  side: "LONG", entryPrice: 100, currentPrice: 97.9, stopPrice: 97, targetPrice: 105,
  state: { history: samples([100,99.8,99.6,99.4,99.2,99,98.8,98.6,98.4,98.2,98,97.9]), highWaterPrice: 100 },
  now: 661_000,
});
assert.equal(adverse.action, "CLOSE");
assert.equal(adverse.reason, "ADAPTIVE_ADVERSE_CUT");

const recovery = evaluateAdaptiveMarketPosition({
  side: "LONG", entryPrice: 100, currentPrice: 98.7, stopPrice: 97, targetPrice: 105,
  state: { history: samples([100,99.8,99.6,99.4,99.2,99,98.8,98.6,98.4,98.3,98.5,98.7]), highWaterPrice: 100 },
  now: 661_000,
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

assert.equal(selectLeverUpPositionAction({ fixedAction: { action: "HOLD" }, adaptive: { action: "HOLD" }, aiReview: { status: "REVIEWED", action: "CLOSE", confidence: 99 } }).action, "HOLD", "AI must not independently force an early close");

const minorPullback = evaluateAdaptiveMarketPosition({ side: "LONG", entryPrice: 100, currentPrice: 104.2, stopPrice: 96, targetPrice: 110, state: { history: samples([100,101,102,103,104,104.4,104.1,104.3]), highWaterPrice: 104.4, peakFavourablePct: 4.4 }, now: 481_000 });
assert.notEqual(minorPullback.action, "CLOSE", "ordinary pullback must not trigger an early close");
const sustainedReversal = evaluateAdaptiveMarketPosition({ side: "LONG", entryPrice: 100, currentPrice: 103, stopPrice: 96, targetPrice: 110, state: { history: samples([110,109,108,107,106,105,104.5,104,103.8,103.5,103.2]), highWaterPrice: 110, peakFavourablePct: 10 }, now: 661_000 });
assert.equal(sustainedReversal.action, "CLOSE", "sustained reversal should still close");
const worker = await readFile("reconstructed/patched-worker.js", "utf8");
const managerStart = worker.indexOf("async function runLeverUpPositionManager(");
const managerEnd = worker.indexOf('__name(runLeverUpPositionManager', managerStart);
assert.ok(managerStart >= 0 && managerEnd > managerStart, "built Worker must contain the live position manager and its end marker");
const managerSource = worker.slice(managerStart, managerEnd > managerStart ? managerEnd : undefined);
assert.ok(managerSource.includes("hyperliquidPriceRawForPosition(position, marketData.markets)"), "live decisions must use Hyperliquid market prices");
assert.ok(!managerSource.includes("fetchLatestOraclePrices"), "live manager must not poll LeverUp oracle prices");
assert.ok(managerSource.includes("readPairByBaseV4)(position.pairBase"), "LeverUp pair metadata may only be read at execution time");
console.log("PASS: patient exits, sustained reversals, hard stops, Hyperliquid-only decisions and reversal queue");
