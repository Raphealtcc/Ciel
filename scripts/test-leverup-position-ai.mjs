import assert from "node:assert/strict";
import { getGeminiApiKeys, getPositionAiProviderCount, parseGeminiApiKeys, reservePositionAiProviderBudget, POSITION_AI_DAILY_LIMITS, reviewEntrySignalWithAI, reviewLeverUpPositionWithAI, reviewLeverUpPositionWithGemini } from "../src/leverup-position-ai.js";

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
assert.equal(cooldownResult.retryAt, 10_000 + 15 * 60_000);
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

let actualFeePrompt = "";
const actualFeeReview = await reviewLeverUpPositionWithGemini({
  env: { GEMINI_API_KEYS: "good-key", GEMINI_MODEL: "test-model", CIEL_STATE: storage },
  position: {
    positionHash: "0x" + "dd".repeat(32), symbol: "ETH", isLong: false,
    marginToken: "LVMON", marginRaw: "1000000000000000000", leverage: 100,
    openFeeRaw: "1200", executionFeeRaw: "300", fundingFeeRaw: "400",
    holdingFeeRaw: "500", accruedFundingFeeRaw: "50", accruedHoldingFeeRaw: "60"
  },
  currentPriceRaw: "90",
  adaptive: { favourablePct: 0.2 },
  now: 30_000,
  dependencies: {
    fetchImpl: async (_url, options) => {
      actualFeePrompt = JSON.parse(options.body).contents[0].parts[0].text;
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        action: "HOLD", confidence: 70, reversalConfirmed: false, reason: "Actual fee snapshot supplied."
      }) }] } }] }) };
    }
  }
});
assert.equal(actualFeeReview.status, "REVIEWED");
const actualFeeSnapshot = JSON.parse(actualFeePrompt.split("Position snapshot: ")[1]).feeContext;
assert.equal(actualFeeSnapshot.estimatedRoundTripFeePct, null);
assert.equal(actualFeeSnapshot.actualFeeSnapshot.marginToken, "LVMON");
assert.equal(actualFeeSnapshot.actualFeeSnapshot.openFeeRaw, "1200");


const makeBudgetStorage = () => {
  const values = new Map();
  return {
    values,
    get: async (key) => values.get(key) ?? null,
    put: async (key, value) => { values.set(key, value); }
  };
};

// Workers AI is the primary position-review provider.
let qwenCalls = 0;
const qwenStorageWrites = new Map();
const qwenStorage = {
  get: async (key) => qwenStorageWrites.get(key) ?? null,
  put: async (key, value) => { qwenStorageWrites.set(key, value); }
};
const qwenReview = await reviewLeverUpPositionWithAI({
  env: {
    CIEL_STATE: qwenStorage,
    AI: {
      run: async (model, options) => {
        qwenCalls++;
        assert.equal(model, "@cf/qwen/qwen3.8-27b");
        assert.equal(options.temperature, 0.1);
        assert.equal(options.max_completion_tokens, 256);
        assert.equal(options.reasoning_effort, "low");
        assert.equal(options.chat_template_kwargs.enable_thinking, false);
        assert.equal(options.response_format.type, "json_object");
        assert.equal(options.messages[0].role, "system");
        return { response: JSON.stringify({
          action: "HOLD", confidence: 88, reversalConfirmed: false, reason: "Trend remains aligned."
        }) };
      }
    }
  },
  position: { positionHash: "0x" + "11".repeat(32), symbol: "BTC", isLong: true },
  currentPriceRaw: "105",
  now: 100_000
});
assert.equal(qwenCalls, 1);
assert.equal(qwenReview.status, "REVIEWED");
assert.equal(qwenReview.provider, "CLOUDFLARE_WORKERS_AI");
assert.equal(qwenReview.model, "@cf/qwen/qwen3.8-27b");
assert.equal(qwenReview.action, "HOLD");
assert.equal(qwenReview.configuredProviderCount, 1);
assert.equal(JSON.parse(qwenStorageWrites.get("ciel:leverup:gemini-review:last")).provider, "CLOUDFLARE_WORKERS_AI");
const qwenBudget = JSON.parse(qwenStorageWrites.get("ciel:position-ai-budget:v1:1970-01-01"));
assert.equal(qwenBudget.workersAiCalls, 1);
assert.equal(qwenBudget.totalProviderCalls, 1);

// Groq is attempted only after Workers AI fails, then uses a strict JSON response.
let groqCalls = 0, groqUrl = "";
const groqReview = await reviewLeverUpPositionWithAI({
  env: {
    CIEL_STATE: makeBudgetStorage(),
    GROQ_API_KEY: "test-groq-key",
    GROQ_POSITION_AI_MODEL: "qwen/qwen3.8-27b",
    AI: { run: async () => { throw new Error("QWEN_TEST_OUTAGE"); } }
  },
  position: { positionHash: "0x" + "22".repeat(32), symbol: "ETH", isLong: false },
  currentPriceRaw: "2000",
  now: 110_000,
  dependencies: {
    fetchImpl: async (url, options) => {
      groqCalls++;
      groqUrl = url;
      assert.equal(options.headers.authorization, "Bearer test-groq-key");
      const request = JSON.parse(options.body);
      assert.equal(request.model, "qwen/qwen3.8-27b");
      assert.equal(request.response_format.type, "json_object");
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({
          action: "CLOSE", confidence: 91, reversalConfirmed: false, reason: "Momentum broke down."
        }) } }] })
      };
    }
  }
});
assert.equal(groqCalls, 1);
assert.equal(groqUrl, "https://api.groq.com/openai/v1/chat/completions");
assert.equal(groqReview.status, "REVIEWED");
assert.equal(groqReview.provider, "GROQ");
assert.equal(groqReview.action, "CLOSE");
assert.equal(groqReview.configuredProviderCount, 2);

// If Qwen and Groq fail, the existing Gemini key rotation remains the final fallback.
let fallbackFetchCalls = 0;
const tripleFallback = await reviewLeverUpPositionWithAI({
  env: {
    CIEL_STATE: makeBudgetStorage(),
    AI: { run: async () => { throw new Error("QWEN_UNAVAILABLE"); } },
    GROQ_API_KEY: "test-groq-key",
    GEMINI_API_KEYS: "gemini-test-key",
    GEMINI_MODEL: "gemini-test-model"
  },
  position: { positionHash: "0x" + "33".repeat(32), symbol: "SOL", isLong: true },
  currentPriceRaw: "150",
  now: 120_000,
  dependencies: {
    fetchImpl: async (url) => {
      fallbackFetchCalls++;
      if (url.includes("groq.com")) return { ok: false, status: 429 };
      return {
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({
          action: "HOLD", confidence: 73, reversalConfirmed: false, reason: "Mixed evidence."
        }) }] } }] })
      };
    }
  }
});
assert.equal(fallbackFetchCalls, 2);
assert.equal(tripleFallback.status, "REVIEWED");
assert.equal(tripleFallback.provider, "GEMINI");
assert.equal(tripleFallback.action, "HOLD");
assert.equal(tripleFallback.configuredProviderCount, 3);
assert.equal(getPositionAiProviderCount({
  AI: { run: () => {} }, GROQ_API_KEY: "x", GEMINI_API_KEYS: "a"
}), 3);

console.log("PASS: Qwen Workers AI is primary, Groq is secondary, and existing Gemini key rotation remains the tertiary fallback.");


// New-entry AI review uses the same Qwen-first / Groq-second chain; Gemini remains in the caller.
const entryPrompt = "Only inspect this supplied BTC trend, funding, order-book and forecast snapshot. Return APPROVE, REJECT or WAIT.";
const qwenEntry = await reviewEntrySignalWithAI({
  env: {
    AI: {
      run: async (model, options) => {
        assert.equal(model, "@cf/qwen/qwen3.8-27b");
        assert.equal(options.max_completion_tokens, 256);
        assert.equal(options.reasoning_effort, "low");
        assert.equal(options.chat_template_kwargs.enable_thinking, false);
        assert.equal(options.response_format.type, "json_object");
        assert.equal(options.messages[1].content, entryPrompt);
        assert.ok(options.messages[0].content.includes("Do not require a news catalyst"));
        assert.ok(options.messages[0].content.includes("news is unassessed, not negative evidence"));
        return { response: JSON.stringify({ verdict: "APPROVE", reason: "Evidence is aligned.", flags: ["TREND_ALIGNED"] }) };
      }
    }
  },
  prompt: entryPrompt
});
assert.equal(qwenEntry.verdict, "APPROVE");
assert.equal(qwenEntry.provider, "CLOUDFLARE_WORKERS_AI");
assert.equal(qwenEntry.model, "@cf/qwen/qwen3.8-27b");

let entryGroqCalls = 0;
const groqEntry = await reviewEntrySignalWithAI({
  env: {
    CIEL_STATE: makeBudgetStorage(),
    AI: { run: async () => { throw new Error("QWEN_OFFLINE"); } },
    GROQ_API_KEY: "entry-groq-test"
  },
  prompt: entryPrompt,
  dependencies: {
    fetchImpl: async (url, options) => {
      entryGroqCalls++;
      assert.equal(url, "https://api.groq.com/openai/v1/chat/completions");
      assert.equal(options.headers.authorization, "Bearer entry-groq-test");
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({
          verdict: "WAIT", reason: "Forecast and momentum disagree.", flags: ["FORECAST_CONFLICT"]
        }) } }] })
      };
    }
  }
});
assert.equal(entryGroqCalls, 1);
assert.equal(groqEntry.verdict, "WAIT");
assert.equal(groqEntry.provider, "GROQ");
assert.equal(groqEntry.flags[0], "FORECAST_CONFLICT");

const entryFallbackUnavailable = await reviewEntrySignalWithAI({
  env: { CIEL_STATE: makeBudgetStorage(), AI: { run: async () => { throw new Error("QWEN_OFFLINE"); } }, GROQ_API_KEY: "bad-key" },
  prompt: entryPrompt,
  dependencies: { fetchImpl: async () => ({ ok: false, status: 429 }) }
});
assert.equal(entryFallbackUnavailable, null, "caller must continue into existing Gemini rotation after Qwen/Groq failures");

console.log("PASS: entry signal review uses Qwen then Groq, and returns control for the existing Gemini fallback.");


const fullBudgetStorage = makeBudgetStorage();
await fullBudgetStorage.put("ciel:position-ai-budget:v1:2026-11-18", JSON.stringify({
  date: "2026-11-18", totalProviderCalls: 60, workersAiCalls: POSITION_AI_DAILY_LIMITS.workersAiCalls, groqCalls: 0
}));
assert.equal(await reservePositionAiProviderBudget(fullBudgetStorage, "CLOUDFLARE_WORKERS_AI", Date.parse("2026-11-18T12:00:00Z")), false,
  "Cloudflare inference must stop at its daily model-call ceiling");
assert.equal(await reservePositionAiProviderBudget(fullBudgetStorage, "GROQ", Date.parse("2026-11-18T12:00:00Z")), true,
  "Groq may continue as fallback while total provider calls remain");
const exhaustedTotalBudget = makeBudgetStorage();
await exhaustedTotalBudget.put("ciel:position-ai-budget:v1:2026-11-18", JSON.stringify({
  date: "2026-11-18", totalProviderCalls: POSITION_AI_DAILY_LIMITS.totalProviderCalls, workersAiCalls: 8, groqCalls: 24
}));
assert.equal(await reservePositionAiProviderBudget(exhaustedTotalBudget, "GROQ", Date.parse("2026-11-18T12:00:00Z")), false,
  "the combined Qwen provider chain must stop at the total daily ceiling");
assert.equal(await reservePositionAiProviderBudget(makeBudgetStorage(), "CLOUDFLARE_WORKERS_AI", Date.parse("2026-11-18T12:00:00Z")), false,
  "fail closed when the persistent budget store is unavailable");
console.log("PASS: shared UTC-day AI budget caps Workers AI at 8 calls and total Qwen providers at 32.");
