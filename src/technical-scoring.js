export const MIN_RECOMMENDATION_SCORE = 78;
export function isRecommendationScoreEligible(score) {
  const value = Number(score);
  return Number.isFinite(value) && value >= MIN_RECOMMENDATION_SCORE;
}

const WEIGHTS = Object.freeze({ trend: 25, momentumPerHorizon: 10, structure: 25, timing: 20 });

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const toFinite = (value) => value == null || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;

/**
 * Fixed-denominator evidence score shared by paper and LeverUp-native candidates.
 * Missing evidence earns no points and reduces coverage; it is never silently
 * normalized away. This is technical evidence strength, not win probability.
 */
export function scoreTechnicalEvidence({
  side,
  trendAligned,
  momentumReturns = [],
  momentumVolatilityPerMinutePct = null,
  structureConfirmed = null,
  rsi = null,
}) {
  const direction = String(side || "").toUpperCase();
  if (direction !== "LONG" && direction !== "SHORT") {
    return { score: 0, coveragePct: 0, components: [], missing: ["DIRECTION"], model: "ciel-shared-v1" };
  }

  let score = 0;
  let available = 0;
  const components = [];
  const missing = [];

  if (typeof trendAligned === "boolean") {
    available += WEIGHTS.trend;
    const points = trendAligned ? WEIGHTS.trend : 0;
    score += points;
    components.push({ key: "TREND", points, max: WEIGHTS.trend, status: trendAligned ? "ALIGNED" : "NOT_ALIGNED" });
  } else {
    missing.push("TREND");
  }

  const horizons = ["5M", "15M", "1H"];
  const periods = [5, 15, 60];
  const volatility = toFinite(momentumVolatilityPerMinutePct);
  for (let i = 0; i < horizons.length; i++) {
    const value = toFinite(momentumReturns[i]);
    if (value == null) { missing.push("MOMENTUM_" + horizons[i]); continue; }
    if (!(volatility > 0)) { missing.push("MOMENTUM_VOLATILITY"); continue; }
    available += WEIGHTS.momentumPerHorizon;
    const aligned = direction === "LONG" ? value > 0 : value < 0;
    const normalizedStrength = Math.abs(value) / (volatility * Math.sqrt(periods[i]));
    const points = aligned ? WEIGHTS.momentumPerHorizon * clamp(normalizedStrength / 1.5, 0, 1) : 0;
    score += points;
    components.push({ key: "MOMENTUM_" + horizons[i], points: Number(points.toFixed(2)), max: WEIGHTS.momentumPerHorizon, normalizedStrength: Number(normalizedStrength.toFixed(2)), status: aligned ? "ALIGNED" : "CONFLICTING" });
  }

  if (typeof structureConfirmed === "boolean") {
    available += WEIGHTS.structure;
    const points = structureConfirmed ? WEIGHTS.structure : 0;
    score += points;
    components.push({ key: "STRUCTURE", points, max: WEIGHTS.structure, status: structureConfirmed ? "CONFIRMED" : "NOT_CONFIRMED" });
  } else {
    missing.push("STRUCTURE_UNAVAILABLE");
  }

  const strength = toFinite(rsi);
  if (strength != null && strength >= 0 && strength <= 100) {
    available += WEIGHTS.timing;
    const ideal = direction === "LONG" ? 60 : 40;
    const points = clamp(WEIGHTS.timing - Math.abs(strength - ideal) * 1.25, 0, WEIGHTS.timing);
    score += points;
    components.push({ key: "ENTRY_TIMING_RSI", points: Number(points.toFixed(2)), max: WEIGHTS.timing, status: points >= 15 ? "FAVOURABLE" : points >= 8 ? "MIXED" : "POOR" });
  } else {
    missing.push("RSI");
  }

  return {
    score: Number(clamp(score, 0, 100).toFixed(2)),
    coveragePct: Number((available).toFixed(2)),
    components,
    missing,
    model: "ciel-shared-v1",
    interpretation: "Technical evidence strength only; not a win probability.",
  };
}
