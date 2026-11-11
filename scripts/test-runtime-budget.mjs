import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile("reconstructed/patched-worker.js", "utf8");
const start = source.indexOf("  async bootstrapBenchmarkHistory(now) {");
const end = source.indexOf("  async writeCandleSnapshots(now) {", start);
assert.ok(start >= 0 && end > start, "bootstrap method exists");
const bootstrap = source.slice(start, end);
assert.ok(bootstrap.includes("now - 24 * 60 * 60 * 1e3"), "bootstrap is limited to 24h");
assert.ok(!bootstrap.includes("INSERT OR IGNORE INTO market_samples"), "bootstrap does not duplicate historical candle samples into market_samples");
assert.ok(bootstrap.includes("INSERT OR IGNORE INTO market_candles"), "native 5m candle archive remains");

assert.ok(source.includes("Math.floor(now / (10 * 60 * 1e3))"), "wider-watchlist sample cadence is 10m");
assert.ok(source.includes("ciel:intraday-empty:v1:"), "empty intraday results are cached");
assert.ok(source.includes("emptyCachedAt < 60 * 60 * 1e3") || source.includes("now - emptyCachedAt < 60 * 60 * 1e3"), "empty intraday cache is time-bounded");
assert.ok(source.includes("ciel:advisor:audit-throttle:v1:"), "rejection audit throttle uses KV");
assert.ok(source.includes('persistRejectedAudit("market-quality:" + candidate.symbol'), "market-quality rejection writes are throttled");
assert.ok(source.includes('persistRejectedAudit("positioning:" + candidate.symbol'), "positioning rejection writes are throttled");
console.log("PASS: runtime D1 budget guards cap bootstrap writes, cache empty intraday scans and throttle repeated rejection audit writes.");
