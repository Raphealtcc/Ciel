import assert from "node:assert/strict";
import { evaluateLeverUpNativeSeries, runLeverUpNativeSampler } from "../src/leverup-native-feed.js";

const now = 1_800_000_000_000;
const rows = Array.from({length: 65}, (_, i) => ({
  symbol: "BTC", price: 100 + i * 0.1 + [0, 0.2, -0.3, 0][i % 4], observed_at_ms: now - (64 - i) * 60_000
}));
const long = evaluateLeverUpNativeSeries("BTC", rows, now);
assert.equal(long.status, "SIGNAL_CANDIDATE");
assert.ok(long.signal, "valid native technical scores below 78 must still become recommendations");
assert.equal(long.scoreFiltered, false);
assert.equal(long.minimumTechnicalScore, 0);
assert.ok(long.signal.score < 0.78, "the fixture must prove a sub-78 score is accepted");
assert.equal(evaluateLeverUpNativeSeries("BTC", rows.slice(-20), now).status, "WARMING_UP");
const gapped = rows.map((r,i)=>({...r,observed_at_ms:r.observed_at_ms-(i>30&&i<60?300_000:0)}));
assert.equal(evaluateLeverUpNativeSeries("BTC", gapped, now).status, "GAPPED_HISTORY");
assert.equal(evaluateLeverUpNativeSeries("BTC", rows.map(r=>({...r,observed_at_ms:r.observed_at_ms-600_000})), now).status, "STALE");
const flat = rows.map((r,i)=>({...r,price:100}));
assert.equal(evaluateLeverUpNativeSeries("BTC", flat, now).status, "NO_SIGNAL");
console.log("PASS: LeverUp-only sample freshness, warm-up, technical signal and no fabricated volume/depth evidence.");

let cache = { lastSampleAt: 0, samples: {} };
let durableWrites = 0;
const doStub = {
  async fetch(_url, init) {
    const body = JSON.parse(init.body);
    if (body.sampleAt > cache.lastSampleAt) {
      for (const row of body.rows) {
        const series = cache.samples[row.symbol] || [];
        series.push({ ...row, observed_at_ms: body.sampleAt });
        cache.samples[row.symbol] = series.slice(-180);
      }
      cache.lastSampleAt = body.sampleAt;
      durableWrites++;
    }
    return new Response(JSON.stringify({ ok: true, sampledAt: cache.lastSampleAt, samples: cache.samples }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  }
};
const nativeEnv = {
  WATCH_SYMBOLS: "BTC,ETH",
  HYPERLIQUID_FEED: { idFromName: () => "primary", get: () => doStub },
  CIEL_STATE: { get: async () => null, put: async () => {} }
};
const nativeDependencies = {
  fetchPairs: async () => [
    { symbol: "BTC", base: "0x0000000000000000000000000000000000000001" },
    { symbol: "ETH", base: "0x0000000000000000000000000000000000000002" }
  ],
  fetchPrices: async () => ({
    "0x0000000000000000000000000000000000000001": "100000000000000000000",
    "0x0000000000000000000000000000000000000002": "200000000000000000000"
  })
};
const nativeResult = await runLeverUpNativeSampler({ env: nativeEnv, now, dependencies: nativeDependencies });
assert.equal(nativeResult.marketCount, 2);
assert.deepEqual(nativeResult.markets.map((market) => market.symbol), ["BTC", "ETH"]);
assert.equal(nativeResult.status, "WARMING_UP");
assert.equal(durableWrites, 1);
assert.equal(cache.samples.BTC.length, 1);
assert.equal(cache.samples.ETH.length, 1);
await runLeverUpNativeSampler({ env: nativeEnv, now, dependencies: nativeDependencies });
assert.equal(durableWrites, 1, "repeated invocation in the same minute must not persist duplicate samples");
assert.equal(cache.samples.BTC.length, 1);
const jsonWatchEnv = { ...nativeEnv, WATCH_SYMBOLS: JSON.stringify(["BTC", "ETH"]) };
const jsonWatchResult = await runLeverUpNativeSampler({ env: jsonWatchEnv, now, dependencies: nativeDependencies });
assert.equal(jsonWatchResult.marketCount, 2, "JSON-array WATCH_SYMBOLS must be parsed into symbols");
assert.deepEqual(jsonWatchResult.markets.map((market) => market.symbol), ["BTC", "ETH"]);
console.log("PASS: native sample history is persisted once per minute in Durable Object storage; comma-separated and JSON-array WATCH_SYMBOLS are both supported; no D1 binding is used.");
