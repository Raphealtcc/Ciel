import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile("reconstructed/patched-worker.js", "utf8");
const pullbackGate = source.indexOf('strategy:"CORE_PULLBACK_SCALP",reason:"INSUFFICIENT_CLOSED_CANDLE_HISTORY"');
const trendGate = source.indexOf('strategy:"CORE_TREND_CONTINUATION",reason:"INSUFFICIENT_CLOSED_5M_HISTORY"');
assert.ok(pullbackGate >= 0 && trendGate > pullbackGate, "both independent history gates must exist");
assert.ok(source.includes("if (!candles || candles.five.length < 40)"), "5m trend continuation must not depend on 1m candle availability");
assert.ok(source.includes("analyzeCoreTrendContinuation(sym, candles.five, now)"), "5m trend continuation must run with valid 5m history");
console.log("Independent 5m trend continuation gate checks passed.");
