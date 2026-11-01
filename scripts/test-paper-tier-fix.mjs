import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile("reconstructed/patched-worker.js", "utf8");

function extractBetween(start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `Missing source marker: ${start}`);
  const to = source.indexOf(end, from);
  assert.notEqual(to, -1, `Missing end marker: ${end}`);
  return source.slice(from, to).trim();
}

const mapMatch = source.match(/var LEVERUP_MARKET_MAX_LEVERAGE = Object\.freeze\((\{[\s\S]*?\})\);/);
assert.ok(mapMatch, "Could not extract the market leverage map from the patched bundle");

const context = vm.createContext({
  LEVERUP_MARKET_MAX_LEVERAGE: vm.runInNewContext(`(${mapMatch[1]})`),
  PAPER_STARTING_BALANCE_MON: 60,
  PAPER_ACCOUNT_KEY: "ciel:paper:account:v1",
  PAPER_LEVERAGE: 50,
});

const definitions = [
  extractBetween("function freshPaperState", "function minimumMarginForMarketLeverage"),
  extractBetween("function minimumMarginForMarketLeverage", "async function openPaperTrade"),
  extractBetween("async function openPaperTrade", "function paperTradePnl"),
].join("\n");

vm.runInContext(definitions + "\nglobalThis.paperTests = { minimumMarginForMarketLeverage, openPaperTrade };", context);
const { minimumMarginForMarketLeverage, openPaperTrade } = context.paperTests;

function makeStorage(initialBalance = 60, trades = []) {
  const data = new Map([["ciel:paper:account:v1", {
    version: 1,
    startingBalanceMon: 60,
    availableBalanceMon: initialBalance,
    realizedPnlMon: 0,
    trades: structuredClone(trades),
  }]]);
  return {
    data,
    async transaction(fn) { return fn(); },
    async get(key) { return data.get(key); },
    async put(key, value) { data.set(key, structuredClone(value)); },
  };
}

function params(symbol, signalId) {
  return {
    symbol, signalId, side: "LONG", entryPrice: 100, entryMonUsd: 0.2,
    stopPrice: 99.6, targetPrice: 100.8, stopPct: 0.4, targetPct: 0.8,
    confidence: 0.8, strategy: "TEST", holdMinutes: 90,
    mode: "TREND_HOLD", regime: "TREND_UP", now: 1_800_000_000_000,
  };
}

assert.equal(minimumMarginForMarketLeverage(50), 22);
assert.equal(minimumMarginForMarketLeverage(100), 11);
assert.equal(minimumMarginForMarketLeverage(1001), 11);
assert.equal(minimumMarginForMarketLeverage(25), null);
assert.equal(minimumMarginForMarketLeverage(5), null);

const fifty = makeStorage();
const opened50 = await openPaperTrade(fifty, params("BNB", "test-50"));
assert.equal(opened50.opened, true);
assert.equal(opened50.trade.marginMon, 22);
assert.equal(opened50.trade.leverage, 50);
assert.equal(opened50.availableBalanceMon, 38);

const hundred = makeStorage();
const opened100 = await openPaperTrade(hundred, params("XRP", "test-100"));
assert.equal(opened100.opened, true);
assert.equal(opened100.trade.marginMon, 11);
assert.equal(opened100.trade.leverage, 100);
assert.equal(opened100.availableBalanceMon, 49);

const thousandMarket = makeStorage();
const opened1001 = await openPaperTrade(thousandMarket, params("BTC", "test-1001"));
assert.equal(opened1001.opened, true);
assert.equal(opened1001.trade.maxMarketLeverage, 1001);
assert.equal(opened1001.trade.leverage, 100);
assert.equal(opened1001.trade.marginMon, 11);

const unsupported = await openPaperTrade(makeStorage(), params("CASHCAT", "unsupported"));
assert.equal(unsupported.opened, false);
assert.match(unsupported.reason, /unsupported/i);

const insufficient = await openPaperTrade(makeStorage(21.99), params("BNB", "insufficient"));
assert.equal(insufficient.opened, false);
assert.match(insufficient.reason, /22 MON/i);

const duplicateSignalStorage = makeStorage(38, [{
  signalId: "same", symbol: "BNB", status: "CLOSED",
}]);
const duplicateSignal = await openPaperTrade(duplicateSignalStorage, params("BNB", "same"));
assert.equal(duplicateSignal.opened, false);
assert.equal(duplicateSignal.duplicate, true);

const duplicateMarketStorage = makeStorage(38, [{
  signalId: "older", symbol: "BNB", status: "OPEN",
}]);
const duplicateMarket = await openPaperTrade(duplicateMarketStorage, params("BNB", "new"));
assert.equal(duplicateMarket.opened, false);
assert.match(duplicateMarket.reason, /already open/i);

console.log("PASS: 50x and 100x+ leverage tiers, tier margins, unsupported tiers, insufficient balance, duplicate signal, and one-open-trade-per-symbol.");
