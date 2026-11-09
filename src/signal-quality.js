const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;

const REQUIRED_COMPONENTS = Object.freeze({
  "1M_MICRO_MOMENTUM_BREAKOUT": ["1M_MOMENTUM","3M_CONFIRMATION","5M_CONFIRMATION","10M_RANGE_BREAKOUT","MICRO_EMA_CONFIRMATION"],
  "MULTI_MARKET_LEVEL_SWEEP_RECLAIM": ["LEVEL_RECLAIM","3M_REVERSAL","5M_CONFIRMATION"],
  "1M_SWING_REVERSAL+RECLAIM": ["1M_SWING_EXHAUSTION","1M_PIVOT_RECLAIM","1M_RSI_TURN","1M_VOLUME_CONFIRMATION","5M_REVERSAL_CONFIRMATION"],
  "5M_TREND+1M_PULLBACK+RECLAIM": ["5M_TREND_FILTER","1M_PULLBACK","1M_RECLAIM","VOLUME_CONFIRMATION"],
  "5M_TREND_CONTINUATION+BREAKOUT_RETEST": ["5M_EMA_TREND","5M_RANGE_BREAKOUT","5M_BREAKOUT_RETEST","VOLUME_CONFIRMATION"],
});

function componentSet(candidate) {
  return new Set((Array.isArray(candidate?.scoreComponents) ? candidate.scoreComponents : [])
    .map((item) => String(item).trim().split(/\\s+/)[0].toUpperCase()));
}

function structureEvidence(candidate) {
  const strategy = String(candidate?.strategy || "").toUpperCase();
  const components = componentSet(candidate);
  const requiredKey = Object.keys(REQUIRED_COMPONENTS).find((key) => strategy.includes(key));
  if (requiredKey) {
    const required = REQUIRED_COMPONENTS[requiredKey];
    const present = required.filter((key) => components.has(key)).length;
    return {
      score: Math.round(25 * present / required.length),
      complete: present === required.length,
      detail: present + "/" + required.length + " required structure checks",
      missing: required.filter((key) => !components.has(key)),
    };
  }
  const technicalScore = finite(candidate?.scoreDetails?.score);
  if (technicalScore !== null) {
    return { score: Math.round(clamp(technicalScore / 4, 0, 25)), complete: technicalScore >= 60,
      detail: "shared technical evidence " + technicalScore + "/100", missing: [] };
  }
  const count = components.size;
  return { score: Math.min(20, count * 5), complete: count >= 3,
    detail: count + " recorded technical components", missing: count >= 3 ? [] : ["THREE_INDEPENDENT_STRUCTURE_COMPONENTS"] };
}

function isCounterTrend(candidate) {
  const strategy = String(candidate?.strategy || "").toUpperCase();
  return candidate?.mode === "RANGE_SCALP" ||
    strategy.includes("LEVEL_SWEEP") ||
    strategy.includes("SWING_REVERSAL");
}

function regimeEvidence(candidate, eventIntel) {
  const side = String(candidate?.side || "").toUpperCase();
  const regime = String(candidate?.regime || "").toUpperCase();
  const strategy = String(candidate?.strategy || "").toUpperCase();
  const counter = isCounterTrend(candidate);
  if (eventIntel?.marketImpact === "BROAD_RISK_OFF" && side === "LONG") {
    return { score: 0, allowed: false, reason: "BROAD_RISK_OFF_LONG_VETO" };
  }
  if (strategy.includes("LEVEL_SWEEP") && regime !== "LEVEL_REVERSAL") {
    return { score: 0, allowed: false, reason: "LEVEL_SWEEP_REGIME_MISMATCH" };
  }
  if (strategy.includes("SWING_REVERSAL") && regime !== "COUNTER_TREND_REVERSAL") {
    return { score: 0, allowed: false, reason: "SWING_REVERSAL_REGIME_MISMATCH" };
  }
  if (!counter && (side === "LONG" && regime !== "TREND_UP" || side === "SHORT" && regime !== "TREND_DOWN")) {
    return { score: 0, allowed: false, reason: "TREND_REGIME_DIRECTION_MISMATCH" };
  }
  if (counter) return { score: 3, allowed: true, reason: "COUNTER_TREND_STRUCTURE_REQUIRED" };
  return { score: 5, allowed: true, reason: "TREND_REGIME_ALIGNED" };
}

export function evaluateSignalQuality({ candidate, forecast, market, eventIntel = null }) {
  const vetoes = [];
  const components = [];
  const side = String(candidate?.side || "").toUpperCase();
  const strategy = String(candidate?.strategy || "").toUpperCase();
  const stopPct = finite(candidate?.stopPct);
  const targetPct = finite(candidate?.targetPct);
  const spreadBps = finite(market?.spreadBps);
  const depthUsd = finite(market?.topDepthUsd);
  const volumeUsd = finite(market?.volume);
  const funding = finite(market?.funding);
  const premiumBps = finite(market?.premiumBps);
  const oiChangePct = finite(market?.oiChangePct);
  const medianReturnPct = finite(forecast?.medianReturnPct);

  if (!["LONG","SHORT"].includes(side)) vetoes.push("INVALID_DIRECTION");
  if (!market || [spreadBps,depthUsd,volumeUsd,funding,premiumBps,oiChangePct].some((value) => value === null)) vetoes.push("INCOMPLETE_MARKET_EVIDENCE");
  if (!forecast?.available || medianReturnPct === null) vetoes.push("STATISTICAL_FORECAST_UNAVAILABLE");
  if (!(stopPct > 0 && targetPct > 0)) vetoes.push("INVALID_STOP_OR_TARGET");

  const structure = structureEvidence(candidate || {});
  components.push({ key: "PRICE_STRUCTURE", score: structure.score, max: 25, detail: structure.detail });
  if (!structure.complete) vetoes.push("INCOMPLETE_STRATEGY_STRUCTURE:" + structure.missing.join(","));

  let forecastScore = 0;
  if (medianReturnPct !== null && stopPct > 0) {
    const minimumMovePct = Math.max(0.08, stopPct * 0.30);
    const aligned = side === "LONG" ? medianReturnPct > 0 : medianReturnPct < 0;
    const opposedMagnitude = Math.abs(medianReturnPct);
    const counter = isCounterTrend(candidate);
    if (!aligned && opposedMagnitude >= minimumMovePct) {
      vetoes.push("FORECAST_STRONGLY_OPPOSES_ENTRY");
    } else if (aligned && opposedMagnitude >= minimumMovePct) {
      forecastScore = 25;
    } else if (counter) {
      forecastScore = 18;
    } else {
      vetoes.push("FORECAST_TOO_WEAK_FOR_TREND_ENTRY");
      forecastScore = 0;
    }
  }
  components.push({ key: "STATISTICAL_FORECAST", score: forecastScore, max: 25,
    detail: medianReturnPct === null ? "unavailable" : medianReturnPct.toFixed(3) + "% median" });

  let spreadScore = 0, depthScore = 0, volumeScore = 0;
  if (spreadBps !== null) {
    if (spreadBps > 20) vetoes.push("SPREAD_ABOVE_HARD_LIMIT");
    else spreadScore = spreadBps <= 3 ? 7 : spreadBps <= 6 ? 6 : spreadBps <= 10 ? 5 : spreadBps <= 15 ? 3 : 1;
  }
  if (depthUsd !== null) {
    if (depthUsd < 500) vetoes.push("TOP_DEPTH_BELOW_HARD_LIMIT");
    else depthScore = depthUsd >= 5000 ? 8 : depthUsd >= 2500 ? 7 : depthUsd >= 1000 ? 5 : 3;
  }
  if (volumeUsd !== null) {
    if (volumeUsd < 250000) vetoes.push("VOLUME_BELOW_HARD_LIMIT");
    else volumeScore = volumeUsd >= 2500000 ? 5 : volumeUsd >= 1000000 ? 4 : volumeUsd >= 500000 ? 3 : 2;
  }
  components.push({ key: "EXECUTION_QUALITY", score: spreadScore + depthScore + volumeScore, max: 20,
    detail: "spread " + (spreadBps ?? "n/a") + " bps; top depth $" + (depthUsd ?? "n/a") + "; 24h volume $" + (volumeUsd ?? "n/a") });

  let fundingScore = 0, premiumScore = 0, oiScore = 0;
  if (funding !== null) {
    const crowdedLong = side === "LONG" && funding >= 0.00005 && premiumBps !== null && premiumBps >= 10;
    const crowdedShort = side === "SHORT" && funding <= -0.00005 && premiumBps !== null && premiumBps <= -10;
    if (crowdedLong || crowdedShort) vetoes.push("DIRECTIONAL_DERIVATIVES_CROWDING");
    fundingScore = Math.abs(funding) <= 0.00005 ? 5 : Math.abs(funding) <= 0.0001 ? 3 : Math.abs(funding) <= 0.0002 ? 1 : 0;
  }
  if (premiumBps !== null) {
    if (Math.abs(premiumBps) > 25) vetoes.push("MARK_ORACLE_PREMIUM_TOO_WIDE");
    premiumScore = Math.abs(premiumBps) <= 5 ? 5 : Math.abs(premiumBps) <= 10 ? 4 : Math.abs(premiumBps) <= 15 ? 3 : 1;
  }
  if (oiChangePct !== null) {
    if (Math.abs(oiChangePct) > 35) vetoes.push("OPEN_INTEREST_SHOCK");
    oiScore = Math.abs(oiChangePct) <= 10 ? 5 : Math.abs(oiChangePct) <= 20 ? 3 : 1;
  }
  components.push({ key: "DERIVATIVES_CONTEXT", score: fundingScore + premiumScore + oiScore, max: 15,
    detail: "funding, mark/oracle premium and OI change" });

  const rr = stopPct > 0 && targetPct > 0 ? targetPct / stopPct : 0;
  let rrScore = rr >= 2 ? 10 : rr >= 1.8 ? 8 : rr >= 1.6 ? 6 : rr >= 1.4 ? 3 : 0;
  if (rr < 1.4) vetoes.push("INSUFFICIENT_REWARD_TO_RISK");
  if (spreadBps !== null && targetPct > 0 && targetPct < (spreadBps / 100) * 2.5) {
    vetoes.push("TARGET_TOO_SMALL_RELATIVE_TO_SPREAD");
    rrScore = 0;
  }
  components.push({ key: "REWARD_TO_RISK", score: rrScore, max: 10, detail: rr.toFixed(2) + "R before fees and funding" });

  const regime = regimeEvidence(candidate || {}, eventIntel);
  components.push({ key: "REGIME_AND_EVENT", score: regime.score, max: 5, detail: regime.reason });
  if (!regime.allowed) vetoes.push(regime.reason);

  const score = Math.round(components.reduce((sum, item) => sum + item.score, 0));
  const threshold = strategy.includes("SWING_REVERSAL") ? 84 :
    strategy.includes("LEVEL_SWEEP") ? 82 :
    strategy.includes("PULLBACK") ? 82 :
    strategy.includes("MICRO_MOMENTUM") ? 84 :
    strategy.includes("CONTINUATION") ? 82 : 80;
  const allowed = vetoes.length === 0 && score >= threshold;
  if (score < threshold) vetoes.push("QUALITY_SCORE_BELOW_THRESHOLD");
  return {
    allowed: allowed && vetoes.length === 0,
    score,
    threshold,
    vetoes,
    components,
    interpretation: "Evidence-quality score, not a win probability or guaranteed return.",
  };
}

export function shouldSuppressDuplicateSignal({ candidate, priorSignal, now }) {
  if (!candidate || !priorSignal) return { suppress: false, reason: "NO_PRIOR_SIGNAL" };
  const createdAt = finite(priorSignal.created_at_ms);
  const priorEntry = finite(priorSignal.entry_price);
  const entry = finite(candidate.entry);
  if (createdAt === null || priorEntry === null || entry === null || priorEntry <= 0 || entry <= 0) {
    return { suppress: false, reason: "INVALID_PRIOR_SIGNAL" };
  }
  const strategy = String(candidate.strategy || "").toUpperCase();
  const mode = String(candidate.mode || "").toUpperCase();
  const windowMs = mode === "RANGE_SCALP" ? 30 * 60000 :
    mode === "CORE_PULLBACK_SCALP" ? 15 * 60000 :
    mode === "CORE_TREND_CONTINUATION" ? 30 * 60000 :
    strategy.includes("MICRO_MOMENTUM") ? 45 * 60000 : 30 * 60000;
  const ageMs = Number(now) - createdAt;
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= windowMs) return { suppress: false, reason: "OUTSIDE_REARM_WINDOW", ageMs, windowMs };
  const displacementPct = Math.abs(entry / priorEntry - 1) * 100;
  const stop = finite(candidate.stopPct) || 0.25;
  const rearmBase = strategy.includes("MICRO_MOMENTUM") ? Math.max(0.5, stop * 1.25) :
    mode === "RANGE_SCALP" ? Math.max(0.35, stop * 0.9) :
    mode === "CORE_PULLBACK_SCALP" ? Math.max(0.25, stop * 0.8) :
    mode === "CORE_TREND_CONTINUATION" ? Math.max(0.35, stop) : Math.max(0.35, stop);
  const rearmPct = clamp(rearmBase, 0.25, 1.0);
  const suppress = displacementPct < rearmPct;
  return { suppress, reason: suppress ? "SAME_SETUP_STILL_ACTIVE" : "PRICE_REARMED",
    ageMs, windowMs, displacementPct, rearmPct };
}
