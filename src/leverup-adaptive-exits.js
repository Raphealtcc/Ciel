// Deterministic, persisted adaptive exit evaluator. It uses LeverUp oracle marks,
// not off-venue prices. The close-to-close range is an ATR proxy because this
// manager receives oracle marks rather than full OHLC candles.
const toBig = (value) => {
  try { return BigInt(value || 0); } catch { return 0n; }
};
const pct = (a, b) => b > 0n ? Number((a - b) * 1_000_000n / b) / 10_000 : 0;
export function evaluateAdaptiveLeverUpExit({ position, currentPriceRaw, state = {}, pairView = {}, now = Date.now(), sampleLimit = 24 }) {
  if (!position?.positionHash || !position?.entryPriceRaw || !currentPriceRaw) {
    return { action: "HOLD", reason: "ADAPTIVE_INPUT_INCOMPLETE", state };
  }
  const price = toBig(currentPriceRaw), entry = toBig(position.entryPriceRaw);
  if (price <= 0n || entry <= 0n) return { action: "HOLD", reason: "ADAPTIVE_PRICE_INVALID", state };
  const history = Array.isArray(state.history) ? state.history.filter((x) => Number(x?.at) > 0 && toBig(x?.price) > 0n) : [];
  const last = history[history.length - 1];
  if (!last || Number(last.at) !== now) history.push({ at: now, price: price.toString() });
  if (history.length > Math.max(8, sampleLimit)) history.splice(0, history.length - Math.max(8, sampleLimit));
  const isLong = Boolean(position.isLong);
  const previousHigh = toBig(state.highWaterRaw);
  const previousLow = toBig(state.lowWaterRaw);
  const highWater = previousHigh > price ? previousHigh : price;
  const lowWater = previousLow > 0n && previousLow < price ? previousLow : price;
  const nextState = { version: 1, positionHash: position.positionHash, history, highWaterRaw: highWater.toString(), lowWaterRaw: lowWater.toString(), updatedAt: now };
  if (history.length < 8) return { action: "HOLD", reason: "ADAPTIVE_WARMUP", samples: history.length, state: nextState };

  const values = history.map((x) => toBig(x.price));
  const recent = values.slice(-8);
  const changes = [];
  for (let i = 1; i < recent.length; i++) {
    const base = recent[i - 1];
    if (base > 0n) changes.push(Math.abs(pct(recent[i], base)));
  }
  const atrProxyPct = changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : 0;
  const trendPct = pct(recent[recent.length - 1], recent[0]);
  const momentumBase = values[Math.max(0, values.length - 4)];
  const momentumPct = pct(price, momentumBase);
  const mean = recent.reduce((sum, value) => sum + value, 0n) / BigInt(recent.length);
  const belowMean = isLong ? price < mean : price > mean;
  const adverseTrend = isLong ? trendPct < -Math.max(atrProxyPct * 1.25, 0.03) : trendPct > Math.max(atrProxyPct * 1.25, 0.03);
  const adverseMomentum = isLong ? momentumPct < -Math.max(atrProxyPct * 0.75, 0.02) : momentumPct > Math.max(atrProxyPct * 0.75, 0.02);
  const depthAbove = Number(pairView?.slippageConfig?.onePercentDepthAboveUsdRaw || 0);
  const depthBelow = Number(pairView?.slippageConfig?.onePercentDepthBelowUsdRaw || 0);
  const shallowSide = isLong ? depthBelow : depthAbove;
  const deepSide = isLong ? depthAbove : depthBelow;
  const liquidityImbalance = shallowSide > 0 && deepSide > 0 && shallowSide / deepSide < 0.35;
  const closeScore = [adverseTrend, adverseMomentum, belowMean, liquidityImbalance].filter(Boolean).length;
  const stop = toBig(position.stopLossRaw);
  let proposedStop = stop;
  if (stop > 0n && atrProxyPct > 0) {
    const atrRaw = entry * BigInt(Math.max(1, Math.round(atrProxyPct * 10_000))) / 1_000_000n;
    const trailDistance = atrRaw * 2n;
    const candidateStop = isLong ? highWater - trailDistance : lowWater + trailDistance;
    if (candidateStop > 0n && (isLong ? candidateStop > stop && candidateStop < price : candidateStop < stop && candidateStop > price)) {
      proposedStop = candidateStop;
    }
  }
  const favourablePct = isLong ? pct(price, entry) : pct(entry, price);
  const targetRaw = toBig(position.takeProfitRaw);
  const targetDistancePct = targetRaw > 0n ? Math.abs(pct(targetRaw, entry)) : 0;
  const peakFavourablePct = isLong ? pct(highWater, entry) : pct(entry, lowWater);
  const givebackPct = Math.max(0, peakFavourablePct - favourablePct);
  const profitProtectionArmPct = targetDistancePct > 0
    ? targetDistancePct * 0.35
    : Math.max(0.12, atrProxyPct * 2.5);
  const profitProtectionArmed = peakFavourablePct >= profitProtectionArmPct;
  const nearTarget = targetDistancePct > 0 && peakFavourablePct >= targetDistancePct * 0.80;
  const recentAgainstSide = recent.length >= 3 && (
    isLong
      ? recent[recent.length - 1] < recent[recent.length - 2] && recent[recent.length - 2] < recent[recent.length - 3]
      : recent[recent.length - 1] > recent[recent.length - 2] && recent[recent.length - 2] > recent[recent.length - 3]
  );
  const targetApproachGiveback = nearTarget && recentAgainstSide &&
    givebackPct >= Math.max(0.025, Math.min(targetDistancePct * 0.10, atrProxyPct * 0.5 || 0.025));
  const profitGivebackTriggered = profitProtectionArmed &&
    givebackPct >= peakFavourablePct * 0.30 &&
    (adverseTrend || adverseMomentum) &&
    (closeScore >= 1 || recentAgainstSide);
  nextState.profitProtection = {
    armed: profitProtectionArmed,
    nearTarget,
    peakFavourablePct,
    currentFavourablePct: favourablePct,
    givebackPct,
    armPct: profitProtectionArmPct,
    updatedAt: now
  };
  if (targetApproachGiveback) {
    return {
      action: "MARKET_CLOSE",
      reason: "TAKE_PROFIT_APPROACH_REVERSAL",
      closeScore, trendPct, momentumPct, atrProxyPct, favourablePct,
      peakFavourablePct, givebackPct, targetDistancePct, state: nextState
    };
  }
  if (profitGivebackTriggered) {
    return {
      action: "MARKET_CLOSE",
      reason: "PROFIT_PROTECTION_PEAK_GIVEBACK",
      closeScore, trendPct, momentumPct, atrProxyPct, favourablePct,
      peakFavourablePct, givebackPct, state: nextState
    };
  }
  // Balanced mode requires multi-factor deterioration, not one noisy indicator.
  if (closeScore >= 3 && history.length >= 10 && favourablePct > 0) {
    return { action: "MARKET_CLOSE", reason: "ADAPTIVE_MULTI_FACTOR_REVERSAL", closeScore, trendPct, momentumPct, atrProxyPct, favourablePct, peakFavourablePct, givebackPct, state: nextState };
  }
  if (proposedStop !== stop) {
    return { action: "UPDATE_TP_SL", reason: "ADAPTIVE_TRAILING_STOP_TIGHTEN", stopLossRaw: proposedStop.toString(), takeProfitRaw: toBig(position.takeProfitRaw).toString(), trendPct, momentumPct, atrProxyPct, closeScore, state: nextState };
  }
  return { action: "HOLD", reason: "ADAPTIVE_NO_CHANGE", trendPct, momentumPct, atrProxyPct, closeScore, state: nextState };
}
