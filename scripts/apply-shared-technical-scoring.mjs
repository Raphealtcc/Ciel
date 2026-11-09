import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const file = path.join(process.cwd(), "reconstructed", "patched-worker.js");
let source = await readFile(file, "utf8");

const importLine = 'import { scoreTechnicalEvidence, isRecommendationScoreEligible } from "../src/technical-scoring.js";';
if (!source.includes(importLine)) source = importLine + "\n" + source;

function once(before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(label + ": expected exactly one match, found " + count);
  source = source.replace(before, after);
  console.log("Applied shared technical scoring: " + label);
}

once(
`  const technicalScore = mode === "RANGE_SCALP"
    ? 0.76
    : clamp(0.66 + (hasTrend ? 0.055 : 0) + (hasMomentum ? 0.055 : 0) + (hasStructure ? 0.045 : 0) + (hasBounce ? 0.06 : 0), 0, 0.95);
  const scoreComponents = mode === "RANGE_SCALP"
    ? ["RANGE_EDGE_OSCILLATOR", "MICRO_REVERSAL", "PRICE_STRUCTURE"]
    : [hasTrend ? "TREND" : null, hasMomentum ? "MOMENTUM" : null, hasStructure ? "PRICE_STRUCTURE" : null, hasBounce ? "BOUNCE" : null].filter(Boolean);`,
`  const sharedTechnicalScore = scoreTechnicalEvidence({
    side,
    trendAligned: hasTrend,
    momentumReturns: [r5, r15, r60],
    structureConfirmed: mode === "RANGE_SCALP" ? true : (hasStructure || hasBounce),
    rsi: rsiAvailable ? rv : null,
  });
  const technicalScore = sharedTechnicalScore.score / 100;
  const scoreComponents = sharedTechnicalScore.components.map((item) => item.key + " " + item.points + "/" + item.max);`,
  "replace paper's baseline/fixed range scores with shared evidence points"
);

once(
  'scoreModel:"regime-switch-v3", strategy:votes.join("+"),',
  'scoreModel:"ciel-shared-v1", scoreDetails:sharedTechnicalScore, strategy:votes.join("+"),',
  "tag paper score model and expose component/coverage details"
);

function ensureNoScoreFloor(variants, replacement, label) {
  const present = variants.filter((pattern) => source.includes(pattern));
  if (!present.length) {
    if (source.includes(replacement)) {
      console.log("Shared scoring: " + label + " already has no numerical floor");
      return;
    }
    throw new Error(label + ": no known source pattern found");
  }
  if (present.length > 1) throw new Error(label + ": multiple score-gate variants found");
  source = source.replace(present[0], replacement);
  console.log("Shared scoring: removed numerical floor from " + label);
}

const trendNoFloor = 'if (signal && signal.confidence >= setting(env.ADVISORY_MIN_CONFIDENCE, 0.72, 0.5, 0.95) && (!isCore || signal.mode === "TREND_HOLD" || signal.mode === "RANGE_SCALP")) candidates.push(signal);';
const scalpNoFloor = 'if (scalp && scalp.confidence >= setting(env.ADVISORY_MIN_CONFIDENCE, 0.72, 0.5, 0.95)) candidates.push(scalp);';
const continuationNoFloor = 'if (continuation && continuation.confidence >= setting(env.ADVISORY_MIN_CONFIDENCE, 0.72, 0.5, 0.95)) candidates.push(continuation);';

ensureNoScoreFloor([
  'if (signal && isRecommendationScoreEligible(signal.confidence * 100) && signal.confidence >= Math.max(0.78, minimumConfidence) && (!isCore || signal.mode === "TREND_HOLD" || signal.mode === "RANGE_SCALP")) candidates.push(signal);',
  'if (signal && signal.confidence >= minimumConfidence && (!isCore || signal.mode === "TREND_HOLD" || signal.mode === "RANGE_SCALP")) candidates.push(signal);',
  'if (signal && signal.confidence >= setting(env.ADVISORY_MIN_CONFIDENCE,0.72,0.5,0.95) && (!isCore || signal.mode === "TREND_HOLD" || signal.mode === "RANGE_SCALP")) candidates.push(signal);',
  'if (signal && signal.confidence >= confidenceFloor && (!isCore || signal.mode === "TREND_HOLD" || signal.mode === "RANGE_SCALP")) candidates.push(signal);',
  'if (signal && (!isCore || signal.mode === "TREND_HOLD" || signal.mode === "RANGE_SCALP")) candidates.push(signal);'
], trendNoFloor, "trend-hold recommendations");
ensureNoScoreFloor([
  'if (scalp && isRecommendationScoreEligible(scalp.confidence * 100) && scalp.confidence >= Math.max(0.78, minimumConfidence)) candidates.push(scalp);',
  'if (scalp && scalp.confidence >= minimumConfidence) candidates.push(scalp);',
  'if (scalp && scalp.confidence >= setting(env.ADVISORY_MIN_CONFIDENCE,0.72,0.5,0.95)) candidates.push(scalp);',
  'if (scalp) candidates.push(scalp);'
], scalpNoFloor, "pullback-scalp recommendations");
ensureNoScoreFloor([
  'if (continuation && isRecommendationScoreEligible(continuation.confidence * 100) && continuation.confidence >= Math.max(0.78, minimumConfidence)) candidates.push(continuation);',
  'if (continuation && continuation.confidence >= minimumConfidence) candidates.push(continuation);',
  'if (continuation && continuation.confidence >= confidenceFloor) candidates.push(continuation);',
  'if (continuation) candidates.push(continuation);'
], continuationNoFloor, "trend-continuation recommendations");

// The trend-hold candidate is already guarded by the earlier strategy-specific patch.

await writeFile(file, source);
console.log("Wrote shared-score Worker candidate: " + file);
