import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  calculateCrossAssetBreadth,
  appendBookFlowSnapshot,
  appendTradeFlowEvents,
  summarizePersistentOrderFlow,
} from "../src/market-confirmation.js";

const now = 2_000_000_000_000;
const symbols = ["BTC","ETH","SOL","BNB","XRP","ADA","DOGE","LINK","AVAX","SUI","UNI","AAVE"];
const history = {};
for (let i = 0; i < symbols.length; i++) {
  const up = i < 9;
  const base = 100 + i;
  history[symbols[i]] = [
    { t: now - 15 * 60000, p: base },
    { t: now - 5 * 60000, p: base * (up ? 1.006 : 0.994) },
    { t: now - 30000, p: base * (up ? 1.012 : 0.988) },
  ];
}
const volumeBySymbol = Object.fromEntries(symbols.map((s) => [s, 1_000_000]));
const breadth = calculateCrossAssetBreadth({ history, symbols, excludeSymbol: "BTC", volumeBySymbol, now });
assert.equal(breadth.status, "READY");
assert.equal(breadth.n5, 11);
assert.ok(breadth.up5Pct > 60 && breadth.up15Pct > 60);
assert.equal(breadth.excludedSymbol, "BTC");

const coreBreadth = calculateCrossAssetBreadth({ history, symbols: ["BTC","ETH","SOL","BNB"], excludeSymbol: "BTC", volumeBySymbol, now });\nassert.equal(coreBreadth.status, "READY");\nassert.equal(coreBreadth.n5, 3);\nassert.equal(coreBreadth.n15, 3);\nconst insufficient = calculateCrossAssetBreadth({ history, symbols: symbols.slice(0, 2), excludeSymbol: "BTC", now });
assert.equal(insufficient.status, "INSUFFICIENT_COVERAGE");
const staleHistory = Object.fromEntries(symbols.map((s) => [s, [{t:now-30*60000,p:100},{t:now-20*60000,p:101},{t:now-10*60000,p:102}]]));
assert.equal(calculateCrossAssetBreadth({ history: staleHistory, symbols, now }).status, "INSUFFICIENT_COVERAGE");

let flow = {};
for (let i = 0; i < 15; i++) {
  const t = now - 28000 + i * 1800;
  flow = appendBookFlowSnapshot(flow, {
    ts_ms: t, best_bid: 100, best_ask: 101,
    bid_size: 10 + i * 1.2, ask_size: 18 - i * 1.2,
  }, t);
}
const buyTrades = Array.from({length:12}, (_,i) => ({
  coin:"BTC", side:"B", px:"100.5", sz:"1", time:now-25000+i*1800, tid:i+1,
}));
flow = appendTradeFlowEvents(flow, buyTrades, now);
const persistent = summarizePersistentOrderFlow(flow, now);
assert.equal(persistent.status, "PERSISTENT");
assert.equal(persistent.direction, "LONG");
assert.ok(persistent.bookEvents >= 8 && persistent.tradeCount >= 5);
assert.ok(persistent.bucketAgreement >= 0.67);

// Price-level transitions must use the signed Cont-style ask contribution.
let askBase = appendBookFlowSnapshot({}, {
  ts_ms: now - 1000, best_bid: 100, best_ask: 101, bid_size: 10, ask_size: 10,
}, now - 1000);
const askFalls = appendBookFlowSnapshot(askBase, {
  ts_ms: now, best_bid: 100, best_ask: 100.5, bid_size: 10, ask_size: 10,
}, now);
assert.equal(askFalls.bookEvents.at(-1).ofi, -10);
askBase = appendBookFlowSnapshot({}, {
  ts_ms: now - 1000, best_bid: 100, best_ask: 101, bid_size: 10, ask_size: 10,
}, now - 1000);
const askRises = appendBookFlowSnapshot(askBase, {
  ts_ms: now, best_bid: 100, best_ask: 101.5, bid_size: 10, ask_size: 10,
}, now);
assert.equal(askRises.bookEvents.at(-1).ofi, 10);

assert.equal(summarizePersistentOrderFlow(null, now).status, "UNAVAILABLE");
const stale = summarizePersistentOrderFlow(flow, now + 60000);
assert.equal(stale.status, "STALE");

const sellFlow = appendTradeFlowEvents(flow, Array.from({length:12}, (_,i) => ({
  coin:"BTC", side:"A", px:"100.5", sz:"2", time:now-20000+i*1000, tid:100+i,
})), now);
assert.notEqual(summarizePersistentOrderFlow(sellFlow, now).status, "PERSISTENT");

const worker = await readFile(new URL("../reconstructed/patched-worker.js", import.meta.url), "utf8");
assert.ok(worker.includes("calculateCrossAssetBreadth"));
assert.ok(worker.includes("appendBookFlowSnapshot"));
assert.ok(worker.includes("appendTradeFlowEvents"));
assert.ok(worker.includes("summarizePersistentOrderFlow"));
assert.ok(worker.includes('subscription: { type: "l2Book", coin: symbol }'));
assert.ok(worker.includes('subscription: { type: "trades", coin: symbol }'));
assert.ok(worker.includes('["BTC", "ETH", "SOL", "BNB"]'), "persistent order-flow capture must include all four active markets");
assert.ok(worker.includes("marketBreadth"));
assert.ok(worker.includes("orderFlow"));
assert.ok(worker.includes('if (["BTC","ETH","SOL","BNB"].includes(symbol))'), "book-flow capture must include BNB alongside BTC, ETH and SOL");
assert.ok(worker.includes("research only"));
console.log("PASS: cross-asset breadth and persistent OFI/trade-flow are computed independently, shown as research-only context, and do not gate entries.");
