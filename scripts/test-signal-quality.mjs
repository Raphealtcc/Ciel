import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { evaluateSignalQuality, shouldSuppressDuplicateSignal } from "../src/signal-quality.js";

const base = {
  candidate: {
    symbol: "BTC", side: "LONG", entry: 100, stopPct: 0.25, targetPct: 0.5,
    strategy: "5M_TREND_CONTINUATION+BREAKOUT_RETEST", mode: "TREND_HOLD", holdMinutes: 180, regime: "TREND_UP",
    scoreComponents: ["5M_EMA_TREND","5M_RANGE_BREAKOUT","5M_BREAKOUT_RETEST","VOLUME_CONFIRMATION"],
  },
  forecast: { available: true, medianReturnPct: 0.22, components: { return5mPct: 0.15, return15mPct: 0.22, return60mPct: 0.35 } },
  market: { spreadBps: 3, topDepthUsd: 8000, volume: 5000000, funding: 0.00001, premiumBps: 2, oiChangePct: 4 },
  eventIntel: { marketImpact: "NEUTRAL" },
};

const good = evaluateSignalQuality(base);
assert.equal(good.allowed, true);
assert.ok(good.score >= good.threshold);
assert.match(good.interpretation, /not a win probability/i);

const missingForecast = evaluateSignalQuality({ ...base, forecast: { available: false, medianReturnPct: null } });
assert.equal(missingForecast.allowed, false);
assert.ok(missingForecast.vetoes.includes("STATISTICAL_FORECAST_UNAVAILABLE"));

const opposingForecast = evaluateSignalQuality({ ...base, forecast: { available: true, medianReturnPct: -0.3 } });
assert.equal(opposingForecast.allowed, false);
assert.ok(opposingForecast.vetoes.includes("FORECAST_STRONGLY_OPPOSES_ENTRY"));

const losingStrategyHistory = evaluateSignalQuality({
  ...base,
  candidate: { ...base.candidate, holdMinutes: 60 },
  strategyStats: { "5M_TREND_CONTINUATION+BREAKOUT_RETEST": { sampleCount: 30, expectancyR: 0.04, winRate: 0.31 } },
});
assert.equal(losingStrategyHistory.allowed, false);
assert.ok(losingStrategyHistory.vetoes.includes("STRATEGY_SHADOW_EXPECTANCY_NOT_POSITIVE"));

const shortHorizonShadowDoesNotVetoTrendHold = evaluateSignalQuality({
  ...base,
  candidate: {
    ...base.candidate, holdMinutes: 180, regime: "LEVEL_REVERSAL",
    strategy: "MULTI_MARKET_LEVEL_SWEEP_RECLAIM",
    scoreComponents: ["LEVEL_RECLAIM","3M_REVERSAL","5M_CONFIRMATION"],
  },
  strategyStats: { "MULTI_MARKET_LEVEL_SWEEP_RECLAIM": { sampleCount: 625, expectancyR: 0.061, winRate: 0.5248 } },
});
assert.equal(shortHorizonShadowDoesNotVetoTrendHold.allowed, true);
assert.ok(!shortHorizonShadowDoesNotVetoTrendHold.vetoes.includes("STRATEGY_SHADOW_EXPECTANCY_NOT_POSITIVE"));

const weakTrendForecast = evaluateSignalQuality({ ...base, forecast: { available: true, medianReturnPct: 0.03 } });
assert.equal(weakTrendForecast.allowed, false);
assert.ok(weakTrendForecast.vetoes.includes("FORECAST_TOO_WEAK_FOR_TREND_ENTRY"));

const crowded = evaluateSignalQuality({ ...base, market: { ...base.market, funding: 0.00008, premiumBps: 14 } });
assert.equal(crowded.allowed, false);
assert.ok(crowded.vetoes.includes("DIRECTIONAL_DERIVATIVES_CROWDING"));

const poorExecution = evaluateSignalQuality({ ...base, market: { ...base.market, spreadBps: 19, topDepthUsd: 510, volume: 260000 } });
assert.ok(poorExecution.score < good.score);

const missingStructure = evaluateSignalQuality({ ...base, candidate: { ...base.candidate, scoreComponents: ["1M_MOMENTUM"] } });
assert.equal(missingStructure.allowed, false);
assert.ok(missingStructure.vetoes.some((v) => v.startsWith("INCOMPLETE_STRATEGY_STRUCTURE")));

const duplicate = shouldSuppressDuplicateSignal({
  candidate: { ...base.candidate, entry: 100.1, stopPct: 0.25 },
  priorSignal: { created_at_ms: 1_000_000, entry_price: 100 },
  now: 1_000_000 + 10 * 60_000,
});
assert.equal(duplicate.suppress, true);
assert.equal(duplicate.reason, "SAME_SETUP_STILL_ACTIVE");

const rearmed = shouldSuppressDuplicateSignal({
  candidate: { ...base.candidate, entry: 100.7, stopPct: 0.25 },
  priorSignal: { created_at_ms: 1_000_000, entry_price: 100 },
  now: 1_000_000 + 10 * 60_000,
});
assert.equal(rearmed.suppress, false);

const swing = evaluateSignalQuality({
  ...base,
  candidate: {
    symbol: "ETH", side: "LONG", entry: 100, stopPct: 0.2, targetPct: 0.4,
    strategy: "1M_SWING_REVERSAL+RECLAIM", mode: "CORE_PULLBACK_SCALP", regime: "COUNTER_TREND_REVERSAL",
    scoreComponents: ["1M_SWING_EXHAUSTION","1M_PIVOT_RECLAIM","1M_RSI_TURN","1M_VOLUME_CONFIRMATION","5M_REVERSAL_CONFIRMATION"],
  },
  forecast: { available: true, medianReturnPct: 0.01, components: { return5mPct: 0.04, return15mPct: 0.08, return60mPct: -0.25 } },
});
assert.equal(swing.allowed, true);

const worker = await readFile(new URL("../reconstructed/patched-worker.js", import.meta.url), "utf8");
assert.ok(worker.includes("evaluateSignalQuality({candidate,forecast,market:reviewerMarket,eventIntel,strategyStats:strategyShadowStats})"));
assert.ok(worker.includes("REPEATED_SETUP_SUPPRESSED"));
assert.ok(worker.includes("ciel:advisor:duplicate:v1:"));
assert.ok(worker.includes('env.CIEL_STATE.get(duplicateSignalKey, "json")'));
assert.ok(worker.includes("env.CIEL_STATE.put(duplicateSignalKey"));
assert.ok(!worker.includes("SELECT created_at_ms,entry_price FROM advisor_positions WHERE symbol=? AND side=? AND strategy=?"), "duplicate suppression must not query D1 per candidate");
assert.ok(worker.includes("5M_REVERSAL_CONFIRMATION"));
assert.ok(worker.includes("Signal quality "));
assert.ok(worker.includes('"Signal quality: " + Number(s?.signalQualityScore || 0) + "/100 evidence score, not win probability"'));
assert.ok(worker.includes("updateAdvisorShadowOutcomes"));
assert.ok(worker.includes("if (now - lastRun < 30 * 60e3) return cached;"), "shadow outcome D1 updates must be throttled to 30 minutes");
assert.ok(worker.includes("statsLastRefreshKey") && worker.includes("6 * 60 * 60e3"), "shadow aggregation must be throttled to six hours");
assert.ok(worker.includes("WHERE status='EXPIRED' AND exit_reason IN"), "shadow aggregation should use the indexed status/created window");
assert.ok(worker.includes("SHADOW_TARGET_FIRST"));
assert.ok(worker.includes("strategyStats:strategyShadowStats"));
console.log("PASS: quality gates, regime-aware evidence, same-setup suppression, 5m reversal confirmation and Worker integration.");
