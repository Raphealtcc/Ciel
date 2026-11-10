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
assert.ok(advisor.includes("coreTrendCandles?.[symbol]"), "native 5m confirmation candles must come from the persistent DO cache");
const d1FallbackGuard = advisor.indexOf("if (missingTrendSymbols.length)");
const d1FallbackQuery = advisor.indexOf("FROM market_candles", d1FallbackGuard);
assert.ok(advisor.includes("const missingTrendSymbols = coreScalpSymbols.filter"), "5m D1 fallback must identify only missing/stale Durable Object buffers");
assert.ok(advisor.includes("now - latest > 7 * 60 * 1000"), "5m D1 fallback must require a stale Durable Object candle cache");
assert.ok(d1FallbackGuard > 0 && d1FallbackQuery > d1FallbackGuard, "5m candle history may be read from D1 only inside the missing/stale-cache fallback, never unconditionally each minute");

assert.ok(source.includes("this.liveMarketInputs(now), this.state.storage, this.coreScalpCandles, this.coreTrendCandles"), "the feed must pass both persistent candle caches to the advisor");
assert.ok(source.includes('this.state.storage.get("coreTrendCandles")'), "the DO must restore the 5m cache");
assert.ok(source.includes('this.state.storage.put("coreTrendCandles", this.coreTrendCandles)'), "the DO must persist the 5m cache");
assert.ok(source.includes("coreTrendCandles?.[symbol]"), "5m candles must be served from DO state");
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
assert.ok(!source.includes("FROM market_candle_hourly_stats WHERE symbol IN"), "advisor scan must not read hourly structure aggregates from D1");
assert.ok(!source.includes("FROM market_candle_hourly_stats WHERE symbol=?"), "candidate evidence must not issue per-symbol hourly D1 reads");
assert.ok(!source.includes("SELECT created_at_ms FROM advisor_ai_audit WHERE symbol=?"), "advisor review cooldown must not scan the D1 audit table");
assert.ok(source.includes("ciel:advisor:review:last:"), "per-symbol review cooldown must use KV");
assert.ok(source.includes("candidateCount:candidates.length"), "scan diagnostics must count discovered candidates");
assert.ok(source.includes("noSetupSymbols"), "scan diagnostics must identify markets with no technical setup");
assert.ok(source.includes("CIEL_ADVISOR_SCAN"), "successful scans must emit structured scan-health logs");
assert.ok(source.includes("CIEL_ADVISOR_REJECT"), "rejected candidates must emit structured rejection reasons");
assert.ok(!source.includes("FROM market_context_snapshots WHERE symbol=? AND ts_ms>=?"), "stale market evidence must fail closed without repeated D1 context reads");
assert.ok(source.includes("now - this.lastHistoryHydrationAt < 24 * 60 * 60 * 1e3"), "D1 history warm-up must run at most once daily");
console.log("PASS: CIEL keeps full one-minute core scalp candles in persistent DO state, retains the public candle endpoint, 5m candles, live context, alerts and market-sample history, while avoiding unconditional D1 5m reads and duplicate D1 1m candle writes.");

const trendWriterStart = source.indexOf("  async writeCandleSnapshots(now) {");
const trendWriterEnd = source.indexOf("  async hydrateHistoryFromD1(now) {", trendWriterStart);
assert.ok(trendWriterStart >= 0 && trendWriterEnd > trendWriterStart, "native 5m snapshot writer must exist");
const trendWriter = source.slice(trendWriterStart, trendWriterEnd);
assert.ok(trendWriter.includes("this.coreTrendCandles[symbol]"), "native 5m core candles must be merged into DO state");
assert.ok(trendWriter.includes("now - 24 * 60 * 60 * 1e3"), "cold-start cache must bootstrap 24 hours of 5m candles once");
assert.ok(trendWriter.includes(".slice(-288)"), "the DO must retain 24 hours of 5m candles");
assert.ok(trendWriter.includes('["BTC","ETH","SOL","BNB"].includes(symbol)'), "the 5m structure cache must include all four enabled markets");
assert.ok(source.includes('new Set(["BTC", "ETH", "MON", "SOL", "BNB"])'), "native 5m candle snapshots must include BNB");
assert.ok(trendWriter.includes('this.state.storage.put("coreTrendCandles", this.coreTrendCandles)'), "native 5m cache must persist across DO restarts");
assert.ok(trendWriter.includes("INSERT OR REPLACE INTO market_candles"), "native 5m history must remain archived in D1");

const outcomeStart = source.indexOf("  async updateAlertOutcomes(now) {");
const outcomeEnd = source.indexOf("\n  }\n};", outcomeStart);
assert.ok(outcomeStart >= 0 && outcomeEnd > outcomeStart, "alert outcome updater must exist");
const outcomeUpdater = source.slice(outcomeStart, outcomeEnd);
assert.ok(outcomeUpdater.includes("lastAlertOutcomeUpdateAt"), "alert analytics must be throttled durably in DO storage");
assert.ok(outcomeUpdater.includes("now - lastUpdate < 5 * 60 * 1e3"), "alert analytics D1 reads must be at most once every five minutes");
assert.ok(outcomeUpdater.includes("LIMIT 30"), "alert analytics batches must be bounded to 30 rows");
