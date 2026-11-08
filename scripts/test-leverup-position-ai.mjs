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
      if (options.headers["x-goog-api-key"] === "bad-key") return { ok: false, status: 401 };
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
console.log("PASS: comma-separated Gemini keys are parsed, invalid keys rotate, and successful key cursor advances.");
