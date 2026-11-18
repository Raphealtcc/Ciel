import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const source = await readFile("reconstructed/patched-worker.js", "utf8");
assert.match(source, /function getPaperSummary\(storage, prices, now, lastTickAt, includeHistory = false\)/);
assert.match(source, /const historyTrades = includeHistory/);
assert.match(source, /bestFavorableMovePct/);
assert.match(source, /byCloseReason: group\("closeReason"\)/);
assert.match(source, /byStrategy: group\("strategy"\)/);
assert.match(source, /const rolling100Trades = pricedClosed\.slice\(0, 100\)/);
assert.match(source, /windowSize: 100, sampleSize: rolling100Trades\.length/);
assert.match(source, /profitFactor: grossLossesMon > 0 \? grossWinsMon \/ grossLossesMon : null/);
assert.match(source, /expectancyMon: totalPnlMon \/ Math\.max\(1, rows\.length\)/);
assert.match(source, /if \(path === "\/paper\/history"\)/);
assert.match(source, /if \(url\.pathname === "\/api\/paper\/history"\)/);
assert.match(source, /getPaperSummary\(this\.state\.storage, this\.latest, Date\.now\(\), this\.lastTickAt, true\)/);
assert.match(source, /openTrades, recentClosed, strategyStats, \.\.\.\(includeHistory \? \{ historyAnalysis \} : \{\}\)/);
console.log("Paper history diagnostics tests passed.");

assert.ok(source.includes("pricedClosed"));
assert.ok(source.includes("feeDataUnavailableCount"));
