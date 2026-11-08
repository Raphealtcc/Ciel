import assert from "node:assert/strict";
import { scoreTechnicalEvidence, MIN_RECOMMENDATION_SCORE, isRecommendationScoreEligible } from "../src/technical-scoring.js";

assert.equal(MIN_RECOMMENDATION_SCORE, 78);
assert.equal(isRecommendationScoreEligible(77.99), false);
assert.equal(isRecommendationScoreEligible(78), true);
assert.equal(isRecommendationScoreEligible(82), true);
assert.equal(isRecommendationScoreEligible(NaN), false);

const native = scoreTechnicalEvidence({ side: "LONG", trendAligned: true, momentumReturns: [0.02, 0.10, 0.15], momentumVolatilityPerMinutePct: 0.001, structureConfirmed: null, rsi: 60 });
assert.equal(native.coveragePct, 75);
assert.equal(native.score, 75);
assert.equal(native.model, "ciel-shared-v1");
assert.ok(native.missing.includes("STRUCTURE_UNAVAILABLE"));

const conflict = scoreTechnicalEvidence({ side: "LONG", trendAligned: true, momentumReturns: [0.02, -0.10, 0.15], momentumVolatilityPerMinutePct: 0.02, structureConfirmed: false, rsi: 75 });
assert.equal(conflict.coveragePct, 100);
assert.ok(conflict.score < native.score);
assert.ok(conflict.components.some((x) => x.status === "CONFLICTING"));

const full = scoreTechnicalEvidence({ side: "SHORT", trendAligned: true, momentumReturns: [-0.02, -0.10, -0.15], momentumVolatilityPerMinutePct: 0.001, structureConfirmed: true, rsi: 40 });
assert.equal(full.coveragePct, 100);
assert.equal(full.score, 100);
assert.match(full.interpretation, /not a win probability/i);

const missing = scoreTechnicalEvidence({ side: "LONG", trendAligned: true, momentumReturns: [0.1, null, 0.2], structureConfirmed: null, rsi: null });
assert.equal(missing.coveragePct, 25);
assert.ok(missing.score <= 45);
console.log("PASS: shared technical scoring is fixed-weight, conservative, coverage-aware and not a win probability.");
