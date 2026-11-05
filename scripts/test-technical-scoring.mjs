import assert from "node:assert/strict";
import { scoreTechnicalEvidence } from "../src/technical-scoring.js";

const native = scoreTechnicalEvidence({ side: "LONG", trendAligned: true, momentumReturns: [0.02, 0.10, 0.15], structureConfirmed: null, rsi: 60 });
assert.equal(native.coveragePct, 75);
assert.equal(native.score, 75);
assert.equal(native.model, "ciel-shared-v1");
assert.ok(native.missing.includes("STRUCTURE_UNAVAILABLE"));

const conflict = scoreTechnicalEvidence({ side: "LONG", trendAligned: true, momentumReturns: [0.02, -0.10, 0.15], structureConfirmed: false, rsi: 75 });
assert.equal(conflict.coveragePct, 100);
assert.ok(conflict.score < native.score);
assert.ok(conflict.components.some((x) => x.status === "CONFLICTING"));

const full = scoreTechnicalEvidence({ side: "SHORT", trendAligned: true, momentumReturns: [-0.02, -0.10, -0.15], structureConfirmed: true, rsi: 40 });
assert.equal(full.coveragePct, 100);
assert.equal(full.score, 100);
assert.match(full.interpretation, /not a win probability/i);

const missing = scoreTechnicalEvidence({ side: "LONG", trendAligned: true, momentumReturns: [0.1, null, 0.2], structureConfirmed: null, rsi: null });
assert.equal(missing.coveragePct, 45);
assert.ok(missing.score <= 45);
console.log("PASS: shared technical scoring is fixed-weight, conservative, coverage-aware and not a win probability.");
