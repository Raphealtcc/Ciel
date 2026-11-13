const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = (value) => value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;

const REQUIRED_COMPONENTS = Object.freeze({
  "MULTI_MARKET_LEVEL_SWEEP_RECLAIM": ["LEVEL_RECLAIM","3M_REVERSAL","5M_CONFIRMATION"],
  "1M_SWING_REVERSAL+RECLAIM": ["1M_SWING_EXHAUSTION","1M_PIVOT_RECLAIM","1M_RSI_TURN","1M_VOLUME_CONFIRMATION","5M_REVERSAL_CONFIRMATION"],
  "5M_TREND+1M_PULLBACK+RECLAIM": ["5M_TREND_FILTER","1M_PULLBACK","1M_RECLAIM","VOLUME_CONFIRMATION"],
  "5M_TREND_CONTINUATION+BREAKOUT_RETEST": ["5M_EMA_TREND","5M_RANGE_BREAKOUT","5M_BREAKOUT_RETEST","VOLUME_CONFIRMATION"],
});

function componentSet(candidate) {
  return new Set((Array.isArray(candidate?.scoreComponents) ? candidate.scoreComponents : [])
    .map((item) => String(item).trim().split(/\s+/)[0].toUpperCase()));
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
  return strategy.includes("LEVEL_SWEEP") ||
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

export function evaluateSignalQuality({ candidate, forecast, market, eventIntel = null, strategyStats = {} }) {
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
  const orderFlow = market?.orderFlow || {};
  const flowStatus = String(orderFlow.status || "").toUpperCase();
  const tradeCount = finite(orderFlow.tradeCount);
  const tradeImbalance = finite(orderFlow.tradeImbalance);
  const medianReturnPct = finite(forecast?.medianReturnPct);

  if (!["LONG","SHORT"].includes(side)) vetoes.push("INVALID_DIRECTION");
  if (!market || [spreadBps,depthUsd,volumeUsd].some((value) => value === null)) vetoes.push("INCOMPLETE_EXECUTION_MARKET_EVIDENCE");
  // Forecast gaps reduce evidence score; they do not erase a valid technical setup.
  if (!(stopPct > 0 && targetPct > 0)) vetoes.push("INVALID_STOP_OR_TARGET");

  const structure = structureEvidence(candidate || {});
  components.push({ key: "PRICE_STRUCTURE", score: structure.score, max: 25, detail: structure.detail });
  if (!structure.complete) vetoes.push("INCOMPLETE_STRATEGY_STRUCTURE:" + structure.missing.join(","));

  let forecastScore = 0, forecastPenalty = 0;
  if (medianReturnPct !== null && stopPct > 0) {
    const minimumMovePct = Math.max(0.08, stopPct * 0.30);
    const aligned = side === "LONG" ? medianReturnPct > 0 : medianReturnPct < 0;
    const opposedMagnitude = Math.abs(medianReturnPct);
    const counter = isCounterTrend(candidate);
    const forecastParts = forecast?.components || {};
    const r5 = finite(forecastParts.return5mPct), r15 = finite(forecastParts.return15mPct), r60 = finite(forecastParts.return60mPct);
    const direction = side === "LONG" ? 1 : -1;
    const f5 = r5 === null ? null : r5 * direction;
    const f15 = r15 === null ? null : r15 * direction;
    const f60 = r60 === null ? null : r60 * direction;
    const trendProjection = finite(forecastParts.trendProjection5mPct);
    const fTrend = trendProjection === null ? null : trendProjection * direction;
    const continuation = strategy.includes("CONTINUATION") || strategy.includes("PULLBACK") || candidate?.mode === "TREND_HOLD";
    const reversal = strategy.includes("LEVEL_SWEEP") || strategy.includes("SWING_REVERSAL");
    if ((continuation || reversal) && (f5 === null || f15 === null)) {
      forecastPenalty += 5;
    } else if (continuation && f60 === null) {
      forecastPenalty += 3;
    } else if (continuation && ((f5 <= -minimumMovePct * 0.5 && f15 <= -minimumMovePct * 0.5) || (f60 <= -0.25 && (f5 <= 0 || f15 <= 0)))) {
      vetoes.push("HIGHER_TIMEFRAME_FORECAST_DISAGREEMENT");
    } else if (reversal && (f5 <= 0 || f15 <= 0 || f60 !== null && f60 < -0.75)) {
      vetoes.push("REVERSAL_LACKS_MULTI_HORIZON_CONFIRMATION");
    }
    // A level sweep against both the 60m move and the 30m fitted slope is
    // usually a pullback, not a confirmed reversal. Require both horizons
    // to oppose the proposed side before vetoing the countertrend setup.
    if (reversal && f60 !== null && fTrend !== null && f60 <= -0.025 && fTrend <= -0.05) {
      vetoes.push("COUNTERTREND_REVERSAL_LACKS_60M_TREND_BREAK");
    }
    if (!aligned && opposedMagnitude >= minimumMovePct) {
      vetoes.push("FORECAST_STRONGLY_OPPOSES_ENTRY");
    } else if (aligned && opposedMagnitude >= minimumMovePct) {
      forecastScore = 25;
    } else if (counter) {
      forecastScore = 18;
      forecastPenalty += 2;
    } else {
      forecastScore = 13;
      forecastPenalty += 3;
    }
  }
  if (medianReturnPct === null) forecastScore = 10;
  const lowerForecast = finite(forecast?.lowerReturnPct), upperForecast = finite(forecast?.upperReturnPct);
  if (lowerForecast !== null && upperForecast !== null && lowerForecast <= 0 && upperForecast >= 0) forecastPenalty += 4;
  forecastScore = Math.max(0, forecastScore - forecastPenalty);
  const flowUsable = !["STALE", "UNAVAILABLE"].includes(flowStatus);
  const flowOpposes = tradeImbalance !== null &&
    (side === "LONG" ? tradeImbalance <= -0.65 : tradeImbalance >= 0.65);
  // Use signed trades as a conflict warning even when book OFI is missing,
  // but only with >=30 trades and a strongly one-sided imbalance.
  if (flowUsable && tradeCount !== null && tradeCount >= 30 && flowOpposes) {
    vetoes.push("SIGNED_TRADE_FLOW_STRONGLY_OPPOSES_ENTRY");
  }
  components.push({ key: "STATISTICAL_FORECAST", score: forecastScore, max: 25,
    detail: medianReturnPct === null ? "unavailable" : medianReturnPct.toFixed(3) + "% median; 5m/15m/60m and 30m slope checked" });

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

  let fundingScore = funding === null ? 2 : 0, premiumScore = premiumBps === null ? 2 : 0, oiScore = oiChangePct === null ? 2 : 0;
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

  // LeverUp's configured default is 3 bps on open and 3 bps on close.
  // Convert the 6 bps round trip to 0.06 percentage points before scoring the setup.
  const roundTripFeePct = 0.06;
  const netTargetPct = targetPct - roundTripFeePct;
  const netStopPct = stopPct + roundTripFeePct;
  const rr = netStopPct > 0 && netTargetPct > 0 ? netTargetPct / netStopPct : 0;
  let rrScore = rr >= 2 ? 10 : rr >= 1.8 ? 8 : rr >= 1.25 ? 6 : rr >= 1.0 ? 3 : 0;
  if (netTargetPct <= 0) vetoes.push("TARGET_DOES_NOT_COVER_ROUND_TRIP_FEES");
  else if (rr < 1.0) vetoes.push("NET_REWARD_TO_RISK_BELOW_1R");
  if (spreadBps !== null && targetPct > 0 && targetPct < (spreadBps / 100) * 2.5) {
    vetoes.push("TARGET_TOO_SMALL_RELATIVE_TO_SPREAD");
    rrScore = 0;
  }
  components.push({ key: "REWARD_TO_RISK", score: rrScore, max: 10,
    detail: rr.toFixed(2) + "R after estimated 3 bps-per-side fees (" + netTargetPct.toFixed(3) + "% net target / " + netStopPct.toFixed(3) + "% net stop)" });

  const regime = regimeEvidence(candidate || {}, eventIntel);
  components.push({ key: "REGIME_AND_EVENT", score: regime.score, max: 5, detail: regime.reason });
  if (!regime.allowed) vetoes.push(regime.reason);

  let score = Math.round(components.reduce((sum, item) => sum + item.score, 0));
  let threshold = strategy.includes("SWING_REVERSAL") ? 78 :
    strategy.includes("LEVEL_SWEEP") ? 78 :
    strategy.includes("PULLBACK") ? 76 :
    strategy.includes("CONTINUATION") ? 76 : 76;
  // Missing statistical forecasts lower the evidence score, but should not veto an otherwise valid technical setup by themselves.
  if (medianReturnPct === null) threshold = Math.max(70, threshold - 5);
  const learned = strategyStats?.[String(candidate?.strategy || "")];
  // Shadow profiles are horizon-specific. Do not use a 12m/15m/60m
  // mid-price result to veto a 180m TREND_HOLD candidate.
  const shadowHorizonMinutes = strategy.includes("MICRO_MOMENTUM") ? 45 :
    strategy.includes("CONTINUATION") ? 180 :
    strategy.includes("SWING_REVERSAL") ? 180 :
    strategy.includes("LEVEL_SWEEP") ? 180 :
    strategy.includes("5M_TREND") && strategy.includes("PULLBACK") ? 180 :
    strategy.includes("PULLBACK") ? 15 : 180;
  const candidateHorizonMinutes = finite(candidate?.holdMinutes) ?? 180;
  const shadowHorizonMatches = Math.abs(candidateHorizonMinutes - shadowHorizonMinutes) <= 1 &&
    Number(learned?.horizonMinutes) === shadowHorizonMinutes;
  let shadowPenalty = 0;
  if (shadowHorizonMatches && Number(learned?.sampleCount) >= 30 && Number.isFinite(Number(learned?.expectancyR))) {
    const expectancyR = Number(learned.expectancyR);
    if (expectancyR <= 0.10) shadowPenalty = expectancyR <= 0 ? 5 : 3;
    else if (expectancyR < 0.20) shadowPenalty = 2;
  }
  score = Math.max(0, score - shadowPenalty);
  const allowed = vetoes.length === 0 && score >= threshold;
  if (score < threshold) vetoes.push("QUALITY_SCORE_BELOW_THRESHOLD");
  return {
    allowed: allowed && vetoes.length === 0,
    score,
    threshold,
    vetoes,
    components,
    shadowPenalty, forecastPenalty,
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
  const windowMs = 30 * 60000;
  const ageMs = Number(now) - createdAt;
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= windowMs) return { suppress: false, reason: "OUTSIDE_REARM_WINDOW", ageMs, windowMs };
  const displacementPct = Math.abs(entry / priorEntry - 1) * 100;
  const stop = finite(candidate.stopPct) || 0.25;
  const rearmBase = Math.max(0.35, stop);
  const rearmPct = clamp(rearmBase, 0.25, 1.0);
  const suppress = displacementPct < rearmPct;
  return { suppress, reason: suppress ? "SAME_SETUP_STILL_ACTIVE" : "PRICE_REARMED",
    ageMs, windowMs, displacementPct, rearmPct };
}
