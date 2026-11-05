import assert from "node:assert/strict";
import { evaluateLeverUpNativeSeries } from "../src/leverup-native-feed.js";

const now = 1_800_000_000_000;
const rows = Array.from({length: 65}, (_, i) => ({
  symbol: "BTC", price: 100 + i * 0.1, observed_at_ms: now - (64 - i) * 60_000
}));
const long = evaluateLeverUpNativeSeries("BTC", rows, now);
assert.equal(long.status, "SIGNAL_CANDIDATE");
assert.equal(long.signal.side, "LONG");
assert.equal(long.signal.executionEligible, false);
assert.ok(long.signal.unavailableEvidence.includes("ORDER_BOOK_DEPTH"));
assert.equal(evaluateLeverUpNativeSeries("BTC", rows.slice(0, 20), now).status, "WARMING_UP");
assert.equal(evaluateLeverUpNativeSeries("BTC", rows.map(r=>({...r,observed_at_ms:r.observed_at_ms-600_000})), now).status, "STALE");
const flat = rows.map((r,i)=>({...r,price:100}));
assert.equal(evaluateLeverUpNativeSeries("BTC", flat, now).status, "NO_SIGNAL");
console.log("PASS: LeverUp-only sample freshness, warm-up, technical signal and no fabricated volume/depth evidence.");
