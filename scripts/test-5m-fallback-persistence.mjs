import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile("reconstructed/patched-worker.js", "utf8");
assert.ok(source.includes("now - last >= 5 * 6e4"), "missing 5m history should retry after five minutes");
assert.ok(source.includes("coreTrendCandles[symbol] = fallback"), "successful D1 5m fallback must update the in-memory trend cache");
assert.ok(source.includes('paperStorage.put("coreTrendCandles", coreTrendCandles)'), "successful D1 5m fallback must persist the cache to Durable Object storage");
assert.ok(source.includes("fallback.length >= 40"), "fallback must retain the 40-candle minimum");
assert.ok(source.includes("const validRows = rows.filter"), "fallback detection must count valid OHLC candles, not just array length");
assert.ok(source.includes("return validRows.length < 40"), "invalid cached OHLC candles must trigger D1 fallback");
console.log("Persistent 5m D1 fallback checks passed.");
