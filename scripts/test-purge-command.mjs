import assert from "node:assert/strict";
import { purgePaperTrades, normalizePurgeSymbol } from "../src/purge-paper.js";
import { purgeLeverUpPositions } from "../src/leverup-coordinator.js";

assert.equal(normalizePurgeSymbol("BTC"), "BTC");
assert.equal(normalizePurgeSymbol("BTC-PERP"), "BTC");
assert.equal(normalizePurgeSymbol("ETH/USDT"), "ETH");
assert.equal(normalizePurgeSymbol(""), null);

const state = {
  availableBalanceMon: 10, realizedPnlMon: 0, realizedPnlUsd: 0,
  closedCount: 0, wins: 0, losses: 0, breakeven: 0,
  trades: [
    { signalId: "btc-1", symbol: "BTC", side: "LONG", status: "OPEN", marginMon: 2, leverage: 50, entryPrice: 100, entryMonUsd: 1 },
    { signalId: "eth-1", symbol: "ETH", side: "SHORT", status: "OPEN", marginMon: 2, leverage: 50, entryPrice: 200, entryMonUsd: 1 },
  ],
};
const storage = {
  async get(key) { return key === "paper" ? structuredClone(state) : null; },
  async put(key, value) { Object.assign(state, structuredClone(value)); },
  async transaction(fn) { return fn(); },
};
const btc = await purgePaperTrades({ storage, accountKey: "paper", prices: { BTC: 101, ETH: 190, MON: 1 }, now: 20000, lastTickAt: 15000, symbol: "BTC" });
assert.equal(btc.closedCount, 1);
assert.equal(btc.closed[0].symbol, "BTC");
assert.equal(state.trades.find(x => x.symbol === "BTC").status, "CLOSED");
assert.equal(state.trades.find(x => x.symbol === "ETH").status, "OPEN");
const all = await purgePaperTrades({ storage, accountKey: "paper", prices: { BTC: 101, ETH: 190, MON: 1 }, now: 21000, lastTickAt: 20000 });
assert.equal(all.closedCount, 1);
assert.equal(state.trades.find(x => x.symbol === "ETH").status, "CLOSED");
const staleState = { availableBalanceMon: 1, trades: [{ signalId: "x", symbol: "SOL", status: "OPEN", marginMon: 1, leverage: 50, entryPrice: 10, entryMonUsd: 1 }] };
const staleStorage = { async get(){return structuredClone(staleState);}, async put(_k,v){Object.assign(staleState,v);}, async transaction(fn){return fn();} };
const stale = await purgePaperTrades({ storage: staleStorage, accountKey: "paper", prices: { SOL: 11, MON: 1 }, now: 50000, lastTickAt: 10000, symbol: "SOL" });
assert.equal(stale.closedCount, 0);
assert.equal(stale.skippedCount, 1);
assert.equal(staleState.trades[0].status, "OPEN");

const blocked = await purgeLeverUpPositions({
  env: { LEVERUP_TRADER_ADDRESS: "0x" + "11".repeat(20), LEVERUP_AGENT_ADDRESS: "0x" + "22".repeat(20), LEVERUP_LIVE_TRADING: "false", LEVERUP_KILL_SWITCH: "true" },
  symbol: "BTC",
  dependencies: {
    fetchPairs: async () => [{ symbol: "BTC", base: "0x" + "33".repeat(20) }],
    fetchOpenPositions: async () => [],
    readPositions: async () => [{ positionHash: "0x" + "44".repeat(32), qty: 1n, isLong: true, pairBase: "0x" + "33".repeat(20) }],
    readPair: async () => ({ slippageConfig: { enabled: true, slippageLongP: 10, slippageShortP: 10 } }),
  },
});
assert.equal(blocked.status, "LIVE_DISABLED");
assert.equal(blocked.openPositionCount, 1);
assert.equal(blocked.submitted, 0);

console.log("PASS: paper purge symbol targeting, mark-based P&L settlement, stale-mark protection, and live kill-gate.");
