const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finitePositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;

/** Shared, deterministic market-aware position manager. Prices are decimal units. */
export function evaluateAdaptiveMarketPosition({
  side, entryPrice, currentPrice, stopPrice = 0, targetPrice = 0,
  state = {}, now = Date.now(), liquidityImbalance = false,
  sampleIntervalMs = 45_000, sampleLimit = 16,
} = {}) {
  const direction = String(side || "LONG").toUpperCase() === "SHORT" ? -1 : 1;
  if (!finitePositive(entryPrice) || !finitePositive(currentPrice)) {
    return { action: "HOLD", reason: "ADAPTIVE_INPUT_INCOMPLETE", state };
  }
  const entry = Number(entryPrice), price = Number(currentPrice);
  const emergencyStop = Number(stopPrice) || 0;
  if (emergencyStop > 0 && (direction === 1 ? price <= emergencyStop : price >= emergencyStop)) {
    return { action: "CLOSE", reason: "HARD_STOP_TRIGGERED", reverseConfirmed: false, state };
  }
  const history = Array.isArray(state.history)
    ? state.history.filter((x) => Number(x?.at) > 0 && finitePositive(x?.price)).slice(-Math.max(8, sampleLimit))
    : [];
  const last = history[history.length - 1];
  if (!last || Number(now) - Number(last.at) >= sampleIntervalMs) history.push({ at: Number(now), price });
  if (history.length > sampleLimit) history.splice(0, history.length - sampleLimit);
  const values = history.map((x) => Number(x.price));
  const recent = values.slice(-8);
  const highWaterPrice = Math.max(Number(state.highWaterPrice) || price, price);
  const lowWaterPrice = Math.min(Number(state.lowWaterPrice) > 0 ? Number(state.lowWaterPrice) : price, price);
  const nextState = {
    version: 1, history, highWaterPrice, lowWaterPrice, updatedAt: Number(now),
    targetExtended: state.targetExtended === true,
    maxHoldExtensions: Math.max(0, Number(state.maxHoldExtensions) || 0),
  };
  if (recent.length < 4) return { action: "HOLD", reason: "ADAPTIVE_WARMUP", samples: recent.length, state: nextState };

  const pctChange = (a, b) => b > 0 ? (a / b - 1) * 100 : 0;
  const stepReturns = [];
  for (let i = 1; i < recent.length; i++) stepReturns.push(Math.abs(pctChange(recent[i], recent[i - 1])));
  const atrProxyPct = stepReturns.length ? stepReturns.reduce((sum, x) => sum + x, 0) / stepReturns.length : 0;
  const trendPct = pctChange(recent[recent.length - 1], recent[0]);
  const momentumPct = pctChange(price, values[Math.max(0, values.length - 4)]);
  const signedTrendPct = direction * trendPct;
  const signedMomentumPct = direction * momentumPct;
  const mean = recent.reduce((sum, x) => sum + x, 0) / recent.length;
  const priceAgainstMean = direction * pctChange(price, mean) < 0;
  const n = recent.length;
  const structureAgainst = n >= 4 && direction * (recent[n - 1] - recent[n - 2]) < 0 && direction * (recent[n - 2] - recent[n - 3]) < 0;
  const adverseTrend = signedTrendPct < -Math.max(atrProxyPct * 1.2, 0.035);
  const adverseMomentum = signedMomentumPct < -Math.max(atrProxyPct * 0.75, 0.025);
  const closeScore = [adverseTrend, adverseMomentum, priceAgainstMean, structureAgainst, liquidityImbalance].filter(Boolean).length;
  const favourablePct = direction * pctChange(price, entry);
  const peakFavourablePct = Math.max(Number(state.peakFavourablePct) || 0,
    direction * pctChange(direction === 1 ? highWaterPrice : lowWaterPrice, entry));
  const givebackPct = Math.max(0, peakFavourablePct - favourablePct);
  const target = Number(targetPrice) || 0, stop = Number(stopPrice) || 0;
  const targetDistancePct = target > 0 ? Math.abs(pctChange(target, entry)) : 0;
  const stopDistancePct = stop > 0 ? Math.abs(pctChange(stop, entry)) : 0;
  const adverseMovePct = Math.max(0, -favourablePct);
  const adverseExtremePrice = direction === 1 ? lowWaterPrice : highWaterPrice;
  const maxAdversePct = Math.max(Number(state.maxAdversePct) || 0,
    Math.max(0, -direction * pctChange(adverseExtremePrice, entry)));
  nextState.peakFavourablePct = peakFavourablePct;
  nextState.maxAdversePct = maxAdversePct;
  nextState.metrics = { trendPct, momentumPct, atrProxyPct, favourablePct, peakFavourablePct, givebackPct, maxAdversePct,
    closeScore, adverseTrend, adverseMomentum, priceAgainstMean, structureAgainst };

  const stopHit = stop > 0 && (direction === 1 ? price <= stop : price >= stop);
  if (stopHit) return { action: "CLOSE", reason: "HARD_STOP_TRIGGERED", reverseConfirmed: false, ...nextState.metrics, state: nextState };

  const targetNear = targetDistancePct > 0 && peakFavourablePct >= targetDistancePct * 0.75;
  const trendStillHealthy = signedTrendPct > Math.max(atrProxyPct * 0.7, 0.025) && signedMomentumPct > 0 && closeScore <= 1;
  if (targetNear && trendStillHealthy && !nextState.targetExtended) {
    const extendedTarget = entry * (1 + direction * (targetDistancePct * 1.75) / 100);
    if (finitePositive(extendedTarget) && extendedTarget !== target) {
      nextState.targetExtended = true;
      return { action: "UPDATE_LEVELS", reason: "TREND_CONTINUATION_TARGET_EXTENSION", stopPrice: stop,
        targetPrice: extendedTarget, targetExtended: true, reverseConfirmed: false, ...nextState.metrics, state: nextState };
    }
  }

  const adverseStreak = (() => {
    let count = 0;
    for (let i = recent.length - 1; i > 0; i--) {
      if (direction * (recent[i] - recent[i - 1]) < 0) count++;
      else break;
    }
    return count;
  })();
  nextState.adverseStreak = adverseStreak;
  nextState.metrics.adverseStreak = adverseStreak;
  const profitArmPct = targetDistancePct > 0
    ? Math.max(targetDistancePct * 0.45, atrProxyPct * 3.5, 0.20)
    : Math.max(0.30, atrProxyPct * 4.0);
  const profitReversal = history.length >= 10 && peakFavourablePct >= profitArmPct &&
    givebackPct >= Math.max(0.20, peakFavourablePct * 0.45, atrProxyPct * 2.5) &&
    adverseTrend && adverseMomentum && priceAgainstMean && structureAgainst &&
    closeScore >= 4 && adverseStreak >= 3;
  if (profitReversal) {
    const reverseConfirmed = adverseTrend && adverseMomentum && priceAgainstMean && structureAgainst && history.length >= 12 && adverseStreak >= 4;
    return { action: "CLOSE", reason: "ADAPTIVE_PROFIT_REVERSAL", reverseConfirmed, ...nextState.metrics, state: nextState };
  }
  const lossCut = stopDistancePct > 0 && history.length >= 12 && closeScore >= 4 &&
    adverseMovePct >= Math.max(stopDistancePct * 0.65, atrProxyPct * 4.0, 0.25) &&
    adverseTrend && adverseMomentum && priceAgainstMean && structureAgainst && adverseStreak >= 4;
  if (lossCut) {
    const reverseConfirmed = priceAgainstMean && structureAgainst && history.length >= 14 && adverseStreak >= 5;
    return { action: "CLOSE", reason: "ADAPTIVE_ADVERSE_CUT", reverseConfirmed, ...nextState.metrics, stopDistancePct, state: nextState };
  }

  const targetHit = target > 0 && (direction === 1 ? price >= target : price <= target);
  if (targetHit) return { action: "CLOSE", reason: "TAKE_PROFIT_TRIGGERED", reverseConfirmed: false, ...nextState.metrics, state: nextState };

  let proposedStop = stop;
  const trailingArmed = peakFavourablePct >= Math.max(stopDistancePct * 0.50, atrProxyPct * 3.5);
  if (trailingArmed && atrProxyPct > 0) {
    // Give a healthy move room to breathe. Tighten only after repeated evidence
    // that momentum/structure is deteriorating; never move an existing stop backwards.
    const trailWeakening = closeScore >= 2 || adverseStreak >= 2;
    const trailMultiplier = trailWeakening ? 3.0 : 4.2;
    const trailFloorPct = trailWeakening ? 0.12 : 0.16;
    const trailCeilingPct = Math.max(trailWeakening ? 0.20 : 0.28,
      stopDistancePct * (trailWeakening ? 0.90 : 1.10));
    const trailDistancePct = clamp(atrProxyPct * trailMultiplier, trailFloorPct, trailCeilingPct);
    const candidateStop = direction === 1 ? highWaterPrice * (1 - trailDistancePct / 100) : lowWaterPrice * (1 + trailDistancePct / 100);
    const tightens = stop <= 0 || (direction === 1 ? candidateStop > stop && candidateStop < price : candidateStop < stop && candidateStop > price);
    if (tightens) proposedStop = candidateStop;
  }
  if (proposedStop > 0 && proposedStop !== stop) {
    return { action: "UPDATE_LEVELS", reason: "VOLATILITY_AWARE_TRAILING_STOP", stopPrice: proposedStop,
      targetPrice: target, targetExtended: nextState.targetExtended, reverseConfirmed: false, ...nextState.metrics, state: nextState };
  }
  return { action: "HOLD", reason: closeScore >= 2 ? "ADVERSE_MARKET_WATCH" : "ADAPTIVE_TREND_INTACT", reverseConfirmed: false, ...nextState.metrics, state: nextState };
}
