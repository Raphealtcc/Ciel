import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile("reconstructed/patched-worker.js", "utf8");
const start = source.indexOf("  async bootstrapBenchmarkHistory(now) {");
const end = source.indexOf("  async writeCandleSnapshots(now) {", start);
assert.ok(start >= 0 && end > start, "bootstrap method exists");
const bootstrap = source.slice(start, end);
assert.ok(bootstrap.includes("const startTime = now - 24 * 60 * 60 * 1000;"), "bootstrap is limited to 24h");
assert.ok(bootstrap.includes("market_candles WHERE symbol=? AND interval='5m' AND open_ts_ms>=?"), "bootstrap coverage uses the candle archive");
assert.ok(bootstrap.includes("coverage?.n || 0) >= 200"), "coverage threshold matches 24h of 5m candles");
assert.ok(bootstrap.includes("validCount < 200"), "one short-history market cannot abort all remaining markets");
assert.ok(!bootstrap.includes("INSERT OR IGNORE INTO market_samples"), "bootstrap does not duplicate historical candle samples");
assert.ok(bootstrap.includes("INSERT OR IGNORE INTO market_candles"), "native 5m candle archive remains");

assert.ok(source.includes("Math.floor(now / (10 * 60 * 1e3))"), "wider-watchlist sample cadence is 10m");
assert.ok(source.includes("ciel:intraday-empty:v1:"), "empty intraday results are cached");
assert.ok(source.includes("now-emptyCachedAt<60*60*1000"), "empty intraday cache is time-bounded");
assert.ok(source.includes("ciel:advisor:audit-throttle:v1:"), "rejection audit throttle uses KV");
assert.ok(source.includes('persistRejectedAudit("market-quality:"+candidate.symbol'), "market-quality rejection writes are throttled");
assert.ok(source.includes('persistRejectedAudit("positioning:"+candidate.symbol'), "positioning rejection writes are throttled");
console.log("PASS: D1 budget guards bound bootstrap writes, avoid empty-history scans and throttle repeated rejection audit writes.");
