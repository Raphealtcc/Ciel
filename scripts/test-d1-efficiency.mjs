import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile("reconstructed/patched-worker.js", "utf8");
const methodStart = source.indexOf("  async writeCoreScalpCandles(now) {");
const methodEnd = source.indexOf("  async writeHistory(rows, alerts, now) {", methodStart);
assert.ok(methodStart >= 0 && methodEnd > methodStart, "core scalp candle writer must exist");
const writer = source.slice(methodStart, methodEnd);
assert.ok(writer.includes('interval: "1m"'), "the one-minute Hyperliquid candle feed must remain active");
assert.ok(writer.includes("this.coreScalpCandles[symbol]"), "one-minute candles must be merged into the in-memory DO cache");
assert.ok(writer.includes('this.state.storage.put("coreScalpCandles", this.coreScalpCandles)'), "one-minute candle history must persist across DO restarts");
assert.ok(writer.includes("candles.slice(-60)"), "the rolling one-minute candle cache must retain sufficient history");
assert.ok(!writer.includes("this.env.DB"), "one-minute scalp candles must not be duplicated in D1");

const restore = source.slice(source.indexOf("async restore()"), source.indexOf("async fetch(request)"));
assert.ok(restore.includes('this.state.storage.get("coreScalpCandles")'), "the DO must restore candle history");
assert.ok(restore.includes("this.coreScalpCandles = values[22] || {};"), "restored candle history must be hydrated");

const advisorStart = source.indexOf("async function runAdvisorCycle");
const advisorEnd = source.indexOf("async function manageOpenPositions", advisorStart);
const advisor = source.slice(advisorStart, advisorEnd);
assert.ok(advisor.includes("coreScalpCandles = {}"), "advisor cycle must accept the DO candle cache");
assert.ok(advisor.includes("coreScalpCandles?.[symbol]"), "core scalp must use the same 1m candle rows");
assert.ok(!advisor.includes("interval=\'1m\'"), "core scalp must not read the duplicated 1m candle table from D1");
assert.ok(advisor.includes("interval=\'5m\'"), "native 5m confirmation candles must remain in D1");

assert.ok(source.includes("this.liveMarketInputs(now), this.state.storage, this.coreScalpCandles"), "the feed must pass its candle cache to the advisor");
assert.ok(source.includes("const refreshCandles = now - this.lastCandleSnapshotAt >= 5 * 60 * 1e3;"), "native 5m candle snapshots must retain their cadence");
assert.ok(source.includes("const refreshContext = now - this.lastContextWriteAt >= 2 * 60 * 1e3;"), "live derivatives context must retain its two-minute refresh");
assert.ok(source.includes("const persistContextSnapshots = !this.lastContextSnapshotPersistAt || now - this.lastContextSnapshotPersistAt >= 15 * 60 * 1e3;"), "historical derivatives snapshots must retain their 15-minute cadence");

const apiStart = source.indexOf('if (url.pathname === "/api/candles")');
const apiEnd = source.indexOf('if (url.pathname === "/api/orderbook")', apiStart);
const candlesRoute = source.slice(apiStart, apiEnd);
assert.ok(candlesRoute.includes('if (interval === "1m")'), "the public 1m candle endpoint must remain");
assert.ok(candlesRoute.includes("FROM market_samples WHERE symbol=?"), "the public 1m endpoint must continue using its existing sample history");

assert.ok(source.includes("const persistAllSamples = Math.floor(now / (6 * 60 * 1e3))"), "watchlist D1 samples must retain their current six-minute persistence cadence");
assert.ok(source.includes("BENCHMARK_PRICE_SYMBOLS.has(row.symbol) || persistAllSamples"), "one-minute benchmark samples and wider-watchlist samples must both remain");
console.log("PASS: CIEL keeps full one-minute core scalp candles in persistent DO state, retains the public candle endpoint, 5m candles, live context, alerts and market-sample history, while removing only duplicate D1 1m candle writes.");

const outcomeStart = source.indexOf("  async updateAlertOutcomes(now) {");
const outcomeEnd = source.indexOf("\n  }\n};", outcomeStart);
assert.ok(outcomeStart >= 0 && outcomeEnd > outcomeStart, "alert outcome updater must exist");
const outcomeUpdater = source.slice(outcomeStart, outcomeEnd);
assert.ok(outcomeUpdater.includes("lastAlertOutcomeUpdateAt"), "alert analytics must be throttled durably in DO storage");
assert.ok(outcomeUpdater.includes("now - lastUpdate < 5 * 60 * 1e3"), "alert analytics D1 reads must be at most once every five minutes");
assert.ok(outcomeUpdater.includes("LIMIT 30"), "alert analytics batches must be bounded to 30 rows");
