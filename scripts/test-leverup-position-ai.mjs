import assert from "node:assert/strict";
import { parseGeminiApiKeys, reviewLeverUpPositionWithGemini } from "../src/leverup-position-ai.js";

assert.deepEqual(parseGeminiApiKeys(" alpha , beta\n gamma;alpha "), ["alpha", "beta", "gamma"]);
const writes = new Map();
const storage = {
  get: async (key) => writes.get(key) ?? null,
  put: async (key, value) => { writes.set(key, value); }
};
let calls = 0;
const result = await reviewLeverUpPositionWithGemini({
  env: { GEMINI_API_KEYS: "bad-key,good-key", GEMINI_MODEL: "test-model", CIEL_STATE: storage },
  position: { positionHash: "0x" + "ab".repeat(32), isLong: true, entryPriceRaw: "100", stopLossRaw: "90", takeProfitRaw: "120" },
  currentPriceRaw: "110",
  adaptive: { closeScore: 3, trendPct: -0.2, momentumPct: -0.1 },
  state: { history: [{ at: 1, price: "100" }] },
  now: 10_000,
  dependencies: {
    fetchImpl: async (_url, options) => {
      calls++;
      if (options.headers["x-goog-api-key"] === "bad-key") return { ok: false, status: 400 };
      return {
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({
          action: "REVERSE", confidence: 91, reversalConfirmed: true, reason: "Momentum and trend reversed."
        }) }] } }] })
      };
    }
  }
});
assert.equal(calls, 2, "invalid key must rotate to the next configured key");
assert.equal(result.status, "REVIEWED");
assert.equal(result.action, "REVERSE");
assert.equal(result.confidence, 91);
assert.equal(result.keyIndexUsed, 2);
assert.equal(writes.get("ciel:gemini:key-cursor"), "0");
const savedReview = JSON.parse(writes.get("ciel:leverup:gemini-review:last"));
assert.equal(savedReview.status, "REVIEWED");
assert.equal(savedReview.action, "REVERSE");
assert.equal(savedReview.configuredKeyCount, 2);
assert.equal(savedReview.keyIndexUsed, 2);
assert.equal(savedReview.symbol, "UNKNOWN");
const cooldownResult = await reviewLeverUpPositionWithGemini({
  env: { GEMINI_API_KEYS: "bad-key,good-key", GEMINI_MODEL: "test-model", CIEL_STATE: storage },
  position: { positionHash: "0x" + "ab".repeat(32), isLong: true },
  currentPriceRaw: "111", now: 20_000,
  dependencies: { fetchImpl: async () => { calls++; throw new Error("should not call during cooldown"); } }
});
assert.equal(cooldownResult.status, "COOLDOWN");
assert.equal(calls, 2);
assert.ok(writes.has("ciel:leverup:gemini-review:cooldown:v1:" + "0x" + "ab".repeat(32)));

let failedCalls = 0;
const exhausted = await reviewLeverUpPositionWithGemini({
  env: { GEMINI_API_KEYS: "key-1,key-2,key-3,key-4,key-5", GEMINI_MODEL: "test-model" },
  position: { positionHash: "0x" + "cd".repeat(32), isLong: true },
  currentPriceRaw: "110",
  now: 20_000,
  dependencies: {
    fetchImpl: async () => {
      failedCalls++;
      return { ok: false, status: 400 };
    }
  }
});
assert.equal(failedCalls, 5, "all five configured keys must be attempted even when every response is HTTP 400");
assert.equal(exhausted.status, "FAILED");
assert.equal(exhausted.configuredKeyCount, 5);

console.log("PASS: comma-separated Gemini keys rotate on HTTP 400 and all five keys are attempted before giving up.");
