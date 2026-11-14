import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile("reconstructed/patched-worker.js", "utf8");
const start = source.indexOf("async function runAdvisorCycle");
const end = source.indexOf("async function manageOpenPositions", start);
assert.ok(start >= 0 && end > start, "advisor cycle source exists");
const advisor = source.slice(start, end);
assert.ok(advisor.includes("const candleResults = await Promise.all(fallbackEligible.map(async (symbol) =>"), "fallback is queried separately per symbol");
assert.ok(advisor.includes("WHERE symbol=? AND interval=? AND open_ts_ms<=? ORDER BY open_ts_ms DESC LIMIT 40"), "each fallback query is bounded to the 40 candles required by trend confirmation and matches the symbol/interval/timestamp index");
assert.ok(advisor.includes("return [symbol, (result.results || []).reverse()]"), "fallback candles are restored to chronological order");
assert.ok(!advisor.includes("ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY open_ts_ms DESC)"), "window-function full scan is removed");
assert.ok(advisor.includes("now - last >= 6 * 60 * 60e3"), "per-symbol fallback reads are throttled to six hours");
assert.ok(!advisor.includes("const placeholders = fallbackEligible.map"), "multi-symbol window query is removed");
console.log("PASS: advisor 5m fallback uses index-backed per-symbol LIMIT 40 queries, throttled to six hours, not a window-function scan.");
