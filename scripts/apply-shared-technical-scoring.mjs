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

once(
  'if (signal && signal.confidence >= setting(env.ADVISORY_MIN_CONFIDENCE, 0.72, 0.5, 0.95)) candidates.push(signal);',
  'if (signal && isRecommendationScoreEligible(signal.confidence * 100) && signal.confidence >= setting(env.ADVISORY_MIN_CONFIDENCE, 0.72, 0.5, 0.95)) candidates.push(signal);',
  "suppress every recommendation below the fixed 78/100 score floor"
);

await writeFile(file, source);
console.log("Wrote shared-score Worker candidate: " + file);
