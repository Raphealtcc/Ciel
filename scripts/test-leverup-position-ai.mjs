import assert from "node:assert/strict";
import { getGeminiApiKeys, parseGeminiApiKeys, reviewLeverUpPositionWithGemini } from "../src/leverup-position-ai.js";

assert.deepEqual(parseGeminiApiKeys(" alpha , beta\n gamma;alpha "), ["alpha", "beta", "gamma"]);
assert.deepEqual(parseGeminiApiKeys('["json-a","json-b"]'), ["json-a", "json-b"]);
assert.deepEqual(parseGeminiApiKeys('"quoted-a","quoted-b"'), ["quoted-a", "quoted-b"]);
assert.deepEqual(getGeminiApiKeys({ GEMINI_API_KEYS: '["shared-a","shared-b"]', GEMINI_API_KEY_1: "numbered-c", GEMINI_API_KEY_2: "shared-a" }), ["shared-a", "shared-b", "numbered-c"]);
const writes = new Map();
const storage = {
  get: async (key) => writes.get(key) ?? null,
  put: async (key, value) => { writes.set(key, value); }
};
let calls = 0, firstPrompt = "";
const result = await reviewLeverUpPositionWithGemini({
  env: { GEMINI_API_KEYS: "bad-key,good-key", GEMINI_MODEL: "test-model", CIEL_STATE: storage },
  position: { positionHash: "0x" + "ab".repeat(32), symbol: "BTC", isLong: true, entryPriceRaw: "100", stopLossRaw: "90", takeProfitRaw: "120" },
  currentPriceRaw: "110",
  adaptive: { closeScore: 3, trendPct: -0.2, momentumPct: -0.1, favourablePct: 0.08 },
  state: { history: [{ at: 1, price: "100" }] },
  now: 10_000,
  dependencies: {
    fetchImpl: async (_url, options) => {
      calls++;
      if (!firstPrompt) firstPrompt = JSON.parse(options.body).contents[0].parts[0].text;
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
const promptSnapshot = JSON.parse(firstPrompt.split("Position snapshot: ")[1]);
assert.equal(promptSnapshot.feeContext.estimatedRoundTripFeePct, 0.06);
assert.equal(promptSnapshot.feeContext.grossFavourableMovePct, 0.08);
assert.equal(promptSnapshot.feeContext.netFavourableMoveAfterEstimatedFeesPct, 0.02);
assert.ok(firstPrompt.includes("Gross mark movement is not net profit"));
assert.equal(writes.get("ciel:leverup:gemini-position:key-cursor"), "0");
assert.equal(writes.has("ciel:gemini:key-cursor"), false);
const savedReview = JSON.parse(writes.get("ciel:leverup:gemini-review:last"));
assert.equal(savedReview.status, "REVIEWED");
assert.equal(savedReview.action, "REVERSE");
assert.equal(savedReview.configuredKeyCount, 2);
assert.equal(savedReview.keyIndexUsed, 2);
assert.equal(savedReview.symbol, "BTC");
assert.equal(savedReview.side, "LONG");
const reviewHistory = JSON.parse(writes.get("ciel:leverup:gemini-review:history:v1"));
assert.equal(reviewHistory.length, 1);
assert.equal(reviewHistory[0].symbol, "BTC");
assert.equal(reviewHistory[0].side, "LONG");
const cooldownResult = await reviewLeverUpPositionWithGemini({
  env: { GEMINI_API_KEYS: "bad-key,good-key", GEMINI_MODEL: "test-model", CIEL_STATE: storage },
  position: { positionHash: "0x" + "ab".repeat(32), isLong: true },
  currentPriceRaw: "111", now: 20_000,
  dependencies: { fetchImpl: async () => { calls++; throw new Error("should not call during cooldown"); } }
});
assert.equal(cooldownResult.status, "COOLDOWN");
assert.equal(calls, 2);
assert.equal(JSON.parse(writes.get("ciel:leverup:gemini-review:history:v1")).length, 1, "cooldown responses must not be stored as actual Gemini decisions");
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

let numberedCalls = 0;
const numbered = await reviewLeverUpPositionWithGemini({
  env: { GEMINI_API_KEY_1: "numbered-key-1", GEMINI_API_KEY_2: "numbered-key-2", GEMINI_MODEL: "test-model", CIEL_STATE: storage },
  position: { positionHash: "0x" + "ef".repeat(32), symbol: "ETH", isLong: false },
  currentPriceRaw: "2000",
  now: 40_000,
  dependencies: {
    fetchImpl: async (_url, options) => {
      numberedCalls++;
      assert.ok(["numbered-key-1", "numbered-key-2"].includes(options.headers["x-goog-api-key"]));
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ action: "HOLD", confidence: 70, reason: "Evidence mixed." }) }] } }] }) };
    }
  }
});
assert.equal(numberedCalls, 1);
assert.equal(numbered.status, "REVIEWED");
assert.equal(numbered.configuredKeyCount, 2, "numbered Cloudflare Gemini secrets must be discovered");

console.log("PASS: CSV/JSON and numbered Gemini secrets are discovered; keys rotate on HTTP 400 and all configured keys are attempted.");
