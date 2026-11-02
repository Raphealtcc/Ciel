import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile("reconstructed/patched-worker.js", "utf8");

function extractBetween(start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, "Missing source marker: " + start);
  const to = source.indexOf(end, from);
  assert.notEqual(to, -1, "Missing end marker: " + end);
  return source.slice(from, to).trim();
}

const mapMatch = source.match(/var LEVERUP_MARKET_MAX_LEVERAGE = Object\.freeze\((\{[\s\S]*?\})\);/);
assert.ok(mapMatch, "Could not extract the market leverage map from the patched bundle");

const sentMessages = [];
const context = vm.createContext({
  LEVERUP_MARKET_MAX_LEVERAGE: vm.runInNewContext("(" + mapMatch[1] + ")"),
  PAPER_STARTING_BALANCE_MON: 100,
  PAPER_ACCOUNT_KEY: "ciel:paper:account:v1",
  PAPER_LEVERAGE: 50,
  MAX_AGE: 120_000,
  fmt: (value) => Number(value).toFixed(4),
  sendTelegram: async (_env, message) => sentMessages.push(message),
  __name: () => {},
  console: { log() {}, error() {} },
});

const definitions = [
  extractBetween("function freshPaperState", "function minimumMarginForMarketLeverage"),
  extractBetween("function minimumMarginForMarketLeverage", "async function openPaperTrade"),
  extractBetween("async function openPaperTrade", "function paperTradePnl"),
  extractBetween("function paperTradePnl", "function updateProfitProtectionState"),
  extractBetween("function updateProfitProtectionState", "async function managePaperTrades"),
  extractBetween("async function managePaperTrades", "async function getPaperSummary"),
  extractBetween("async function getPaperSummary", "function setupMessage"),
].join("\n");

vm.runInContext(
  definitions + "\nglobalThis.paperTests = { minimumMarginForMarketLeverage, paperMarginLimits, choosePaperMargin, openPaperTrade, paperTradePnl, managePaperTrades, getPaperSummary };",
  context,
);
const { minimumMarginForMarketLeverage, paperMarginLimits, choosePaperMargin, openPaperTrade, paperTradePnl, managePaperTrades, getPaperSummary } = context.paperTests;

function makeStorage(initialBalance = 100, trades = []) {
  const data = new Map([["ciel:paper:account:v1", {
    version: 1,
    startingBalanceMon: 100,
    availableBalanceMon: initialBalance,
    realizedPnlMon: 0,
    realizedPnlUsd: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
    closedCount: 0,
    trades: structuredClone(trades),
  }]]);
  return {
    data,
    async transaction(fn) { return fn(); },
    async get(key) { return data.get(key); },
    async put(key, value) { data.set(key, structuredClone(value)); },
  };
}

function params(symbol, signalId, extra = {}) {
  return {
    symbol, signalId, side: "LONG", entryPrice: 100, entryMonUsd: 0.2,
    stopPrice: 99.6, targetPrice: 100.8, stopPct: 0.4, targetPct: 0.8,
    confidence: 0.8, strategy: "TEST", holdMinutes: 90,
    mode: "TREND_HOLD", regime: "TREND_UP", now: 1_800_000_000_000,
    ...extra,
  };
}

assert.equal(minimumMarginForMarketLeverage(50), 22);
assert.equal(minimumMarginForMarketLeverage(100), 11);
assert.equal(minimumMarginForMarketLeverage(1001), 11);
assert.equal(minimumMarginForMarketLeverage(25), null);
assert.equal(minimumMarginForMarketLeverage(5), null);

const limits50 = paperMarginLimits(22, 100, 100, 50, 0.4, 0);
assert.equal(limits50.feasible, true);
assert.equal(limits50.minMarginMon, 22);
assert.equal(limits50.maxMarginMon, 25);
assert.equal(choosePaperMargin(24.5, limits50), 24.5);
assert.equal(choosePaperMargin(100, limits50), 25);
const limits100 = paperMarginLimits(11, 100, 100, 100, 0.4, 0);
assert.equal(limits100.feasible, true);
assert.equal(limits100.maxMarginMon, 12.5);
assert.equal(choosePaperMargin(12.2, limits100), 12.2);
assert.equal(choosePaperMargin(1, limits100), 11);
assert.equal(choosePaperMargin(null, limits100), 11);
assert.equal(paperMarginLimits(22, 100, 100, 50, 0.4, 5.7).feasible, false);
assert.equal(context.LEVERUP_MARKET_MAX_LEVERAGE.BTC, 100);
assert.equal(context.LEVERUP_MARKET_MAX_LEVERAGE.ETH, 100);
assert.equal(minimumMarginForMarketLeverage(context.LEVERUP_MARKET_MAX_LEVERAGE.QNT), null);
assert.equal(minimumMarginForMarketLeverage(context.LEVERUP_MARKET_MAX_LEVERAGE.LIT), null);

const stopLossMath = paperTradePnl({ side: "LONG", entryPrice: 100, entryMonUsd: 0.2, marginMon: 22, leverage: 50 }, 99.6, 0.2);
assert.ok(Math.abs(stopLossMath.mon - (-4.4)) < 1e-9);
assert.ok(Math.abs(stopLossMath.roiPct - (-20)) < 1e-9);
const hundredXStopMath = paperTradePnl({ side: "LONG", entryPrice: 100, entryMonUsd: 0.2, marginMon: 11, leverage: 100 }, 99.6, 0.2);
assert.ok(Math.abs(hundredXStopMath.mon - (-4.4)) < 1e-9);
assert.ok(Math.abs(hundredXStopMath.roiPct - (-40)) < 1e-9);

const fifty = makeStorage();
const opened50 = await openPaperTrade(fifty, params("BNB", "test-50"));
assert.equal(opened50.opened, true);
assert.equal(opened50.trade.marginMon, 22);
assert.equal(opened50.trade.leverage, 50);
assert.equal(opened50.availableBalanceMon, 78);

const aiSized = await openPaperTrade(makeStorage(), params("BNB", "ai-sized", { marginMon: 24.5, leverage: 50 }));
assert.equal(aiSized.opened, true);
assert.equal(aiSized.trade.marginMon, 24.5);
assert.equal(aiSized.availableBalanceMon, 75.5);
const belowVenueMinimum = await openPaperTrade(makeStorage(), params("BNB", "below-minimum", { marginMon: 21.99, leverage: 50 }));
assert.equal(belowVenueMinimum.opened, false);
assert.match(belowVenueMinimum.reason, /minimum of 22 MON/i);

const hundred = makeStorage();
const opened100 = await openPaperTrade(hundred, params("XRP", "test-100"));
assert.equal(opened100.opened, true);
assert.equal(opened100.trade.marginMon, 11);
assert.equal(opened100.trade.leverage, 100);
assert.equal(opened100.availableBalanceMon, 89);

const thousandMarket = makeStorage();
const openedBtc = await openPaperTrade(thousandMarket, params("BTC", "test-btc-100"));
assert.equal(openedBtc.opened, true);
assert.equal(openedBtc.trade.maxMarketLeverage, 100);
assert.equal(openedBtc.trade.leverage, 100);
assert.equal(openedBtc.trade.marginMon, 11);

const unsupported = await openPaperTrade(makeStorage(), params("CASHCAT", "unsupported"));
assert.equal(unsupported.opened, false);
assert.match(unsupported.reason, /unsupported/i);

const insufficient = await openPaperTrade(makeStorage(21.99), params("BNB", "insufficient"));
assert.equal(insufficient.opened, false);
assert.match(insufficient.reason, /22 MON/i);

const duplicateSignalStorage = makeStorage(78, [{ signalId: "same", symbol: "BNB", status: "CLOSED" }]);
const duplicateSignal = await openPaperTrade(duplicateSignalStorage, params("BNB", "same"));
assert.equal(duplicateSignal.opened, false);
assert.equal(duplicateSignal.duplicate, true);

const duplicateMarketStorage = makeStorage(78, [{ signalId: "older", symbol: "BNB", status: "OPEN" }]);
const duplicateMarket = await openPaperTrade(duplicateMarketStorage, params("BNB", "new"));
assert.equal(duplicateMarket.opened, false);
assert.match(duplicateMarket.reason, /already open/i);

// A 0.4% adverse move closes the 50x paper position at the configured stop.
const stopStorage = makeStorage();
const stopOpen = await openPaperTrade(stopStorage, params("BNB", "stop-close"));
const stopNow = stopOpen.trade.openedAtMs + 1_000;
await managePaperTrades(stopStorage, { MON: 0.2, BNB: 99.6 }, stopNow, stopNow - 1_000, {});
const stopped = await stopStorage.get("ciel:paper:account:v1");
assert.equal(stopped.trades[0].status, "CLOSED");
assert.equal(stopped.trades[0].closeReason, "STOP_LOSS");
assert.ok(Math.abs(stopped.realizedPnlMon - (-4.4)) < 1e-9);
assert.ok(Math.abs(stopped.availableBalanceMon - 95.6) < 1e-9);

// A take-profit close returns reserved margin plus gross P&L to free balance.
const targetStorage = makeStorage();
const targetOpen = await openPaperTrade(targetStorage, params("BNB", "target-close"));
const targetNow = targetOpen.trade.openedAtMs + 1_000;
await managePaperTrades(targetStorage, { MON: 0.2, BNB: 100.81 }, targetNow, targetNow - 1_000, {});
const targeted = await targetStorage.get("ciel:paper:account:v1");
assert.equal(targeted.trades[0].closeReason, "TAKE_PROFIT");
assert.ok(Math.abs(targeted.realizedPnlMon - 8.8) < 1e-9);
assert.ok(Math.abs(targeted.availableBalanceMon - 108.8) < 1e-9);

// A position is closed at its maximum hold when the feed is fresh.
const holdStorage = makeStorage();
const holdOpen = await openPaperTrade(holdStorage, params("BNB", "max-hold", { holdMinutes: 1 }));
const holdNow = holdOpen.trade.expiresAtMs + 1;
await managePaperTrades(holdStorage, { MON: 0.2, BNB: 100.1 }, holdNow, holdNow - 1_000, {});
const held = await holdStorage.get("ciel:paper:account:v1");
assert.equal(held.trades[0].closeReason, "MAX_HOLD");

// Profit protection arms at 45% of the target and confirms a 45%+ giveback over multiple samples.
const protectionStorage = makeStorage();
const protectionOpen = await openPaperTrade(protectionStorage, params("BNB", "profit-protection"));
const protectionStart = protectionOpen.trade.openedAtMs + 1_000;
await managePaperTrades(protectionStorage, { MON: 0.2, BNB: 100.409 }, protectionStart, protectionStart - 1_000, {});
for (const elapsed of [4_000, 8_000, 12_000, 16_000, 20_000]) {
  await managePaperTrades(
    protectionStorage,
    { MON: 0.2, BNB: 100.2 },
    protectionStart + elapsed,
    protectionStart + elapsed - 1_000,
    {},
  );
}
const protectedState = await protectionStorage.get("ciel:paper:account:v1");
assert.equal(protectedState.trades[0].closeReason, "PROFIT_PROTECTION");
assert.ok(Math.abs(protectedState.trades[0].bestFavorableMovePct - 0.409) < 1e-9);

// /profits equity reconciles to starting balance plus realised and unrealised P&L.
const summaryStorage = makeStorage();
await openPaperTrade(summaryStorage, params("BNB", "summary-open"));
const summaryNow = 1_800_000_001_000;
const summary = await getPaperSummary(summaryStorage, { MON: 0.2, BNB: 99.68018 }, summaryNow, summaryNow - 1_000);
assert.ok(Math.abs(summary.totalPnlMon - (summary.realizedPnlMon + summary.unrealizedPnlMon)) < 1e-9);
assert.ok(Math.abs(summary.equityMon - (summary.starterBalanceMon + summary.totalPnlMon)) < 1e-9);
assert.ok(Math.abs(summary.equityMon - (summary.availableBalanceMon + summary.openMarginMon + summary.unrealizedPnlMon)) < 1e-6);

// Prevent misleading 50x-only copy after the paper engine becomes leverage-tiered.
assert.ok(source.includes("CIEL PAPER TRADING — AUTOMATIC / LEVERAGE-TIERED"));
assert.ok(source.includes("automatic leverage-tiered paper-trading balance and P&L"));
assert.ok(!source.includes("automatic 50x paper-trading balance and P&L"));
assert.ok(source.includes('String(p.leverage) + "x notional estimate at 100% collateral ratio ≈ "'));
assert.ok(source.includes("free balance is below the eligible market's minimum margin"));
assert.ok(source.includes("const collateral = choosePaperMargin(reviewed.verdict === \"APPROVE\" ? reviewed.paperMarginMon : null, sizingLimits);"));
assert.ok(source.includes("PAPER_STARTING_BALANCE_MON = 100"));
assert.ok(source.includes("paperMarginMon"));
assert.ok(source.includes("const marginSizingSource = reviewed.verdict === \"APPROVE\""));
assert.ok(source.includes("const perpAssets = universe.map((asset) => ({ symbol: String(asset?.name || \"\").trim().toUpperCase(), coin: String(asset?.name || \"\").trim() }))"));
assert.ok(source.includes("missingBooks.slice(offset, offset + 4).map(async ({ symbol, coin }) => {"));
assert.ok(source.includes('JSON.stringify({ type: "l2Book", coin })'));

assert.ok(source.includes('if (!paperStorage) console.log("Ciel paper storage unavailable; advisor recommendations will continue without automatic paper entries.");'));
assert.ok(!source.includes("paperCash + 1e-9 < requiredPaperMargin"));
assert.ok(!source.includes("no new recommendation will be issued until a paper slot is free"));

assert.ok(source.includes('const leverage = marketMaxLeverage >= 100 ? 100 : PAPER_LEVERAGE;'));
assert.ok(source.includes('Margin: " + paperResult.trade.marginMon + " MON | leverage: " + paperResult.trade.leverage + "x'));

assert.ok(source.includes("Reference price source: Hyperliquid mid; LeverUp settles against Pyth and applies per-pair pool slippage. Check LeverUp's live quote before entry."));
assert.ok(source.includes("Hyperliquid market quality: 24h notional"));
assert.ok(source.includes("AI evidence basis: CIEL technical signal, local forecast and Hyperliquid derivatives/order-book metrics only."));
assert.ok(source.includes("Gross Hyperliquid-mid paper result; LeverUp Pyth/pool fills"));
assert.ok(source.includes("Paper results use Hyperliquid mids, not LeverUp Pyth/pool fills."));
assert.equal(context.LEVERUP_MARKET_MAX_LEVERAGE.CASHCAT, 3);
assert.equal(context.LEVERUP_MARKET_MAX_LEVERAGE.PONS, 3);

console.log("PASS: 100 MON budget, 11/22 MON venue floors, AI-selected margins, 5%/10% risk clamps, tiered paper entries, P&L, all paper exits, /profits reconciliation and Telegram copy.");
