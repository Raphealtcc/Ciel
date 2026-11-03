// Independent portfolio risk gate for LeverUp. Fail closed on incomplete account/market data.
export const LEVERUP_RISK_DEFAULTS = Object.freeze({
  totalAllocationMon: 50, reserveMon: 25, minLeverage: 50,
  maxConcurrentPositions: 1, maxDailyRealizedLossMon: 9,
  maxRollingDrawdownMon: 9, maxAggregateStopRiskMon: 6,
  feeBufferPct: 25, slippageBufferPct: 25,
});
const finitePositive = (v) => Number.isFinite(Number(v)) && Number(v) > 0;
export function calculateLeverUpEntryBudget({ minimumCollateralUsd, minimumNotionalUsd, leverage, monUsdPrice, collateralRatio, openFeeUsd = 0, closeFeeUsd = 0, feeBufferPct = 25, slippageBufferPct = 25 }) {
  if (!finitePositive(leverage) || leverage < 50) throw new Error("LEVERUP_MINIMUM_50X_NOT_MET");
  if (!finitePositive(monUsdPrice)) throw new Error("MON_USD_PRICE_UNAVAILABLE");
  let collateralUsd;
  if (finitePositive(minimumCollateralUsd)) collateralUsd = Number(minimumCollateralUsd);
  else {
    if (!finitePositive(minimumNotionalUsd) || !finitePositive(collateralRatio) || collateralRatio > 1) throw new Error("MINIMUM_COLLATERAL_OR_VERIFIED_RATIO_REQUIRED");
    collateralUsd = Number(minimumNotionalUsd) / leverage / Number(collateralRatio);
  }
  const feesUsd = Math.max(0, Number(openFeeUsd) || 0) + Math.max(0, Number(closeFeeUsd) || 0);
  const bufferUsd = collateralUsd * ((Math.max(0, Number(feeBufferPct) || 0) + Math.max(0, Number(slippageBufferPct) || 0)) / 100);
  return { collateralUsd, feesUsd, bufferUsd, requiredUsd: collateralUsd + feesUsd + bufferUsd, requiredMon: (collateralUsd + feesUsd + bufferUsd) / Number(monUsdPrice) };
}
export function evaluateLeverUpPortfolioRisk({ requestedLeverage, totalAllocationMon = 50, reserveMon = 25, availableWmonMon, requestedMarginMon, entryBudgetMon, currentOpenPositions = [], maxConcurrentPositions = 1, proposedStopRiskMon, aggregateStopRiskMon = 0, maxAggregateStopRiskMon = 6, dailyRealizedLossMon = 0, maxDailyRealizedLossMon = 9, rollingDrawdownMon = 0, maxRollingDrawdownMon = 9, staleFeed = false, executionUncertain = false, killSwitchActive = true }) {
  const reasons = [];
  const n = (v) => Number(v);
  if (killSwitchActive) reasons.push("KILL_SWITCH_ACTIVE");
  if (staleFeed) reasons.push("STALE_MARKET_FEED");
  if (executionUncertain) reasons.push("EXECUTION_STATE_UNCERTAIN");
  if (!finitePositive(requestedLeverage) || n(requestedLeverage) < 50) reasons.push("LEVERAGE_BELOW_50X");
  if (!finitePositive(totalAllocationMon) || n(reserveMon) < 0 || n(reserveMon) >= n(totalAllocationMon)) reasons.push("INVALID_ALLOCATION_CONFIGURATION");
  const usable = Math.max(0, n(totalAllocationMon) - n(reserveMon));
  if (!finitePositive(availableWmonMon)) reasons.push("AVAILABLE_WMON_BALANCE_UNKNOWN");
  if (!finitePositive(requestedMarginMon)) reasons.push("REQUESTED_MARGIN_INVALID");
  if (finitePositive(requestedMarginMon) && n(requestedMarginMon) > usable) reasons.push("TRADE_EXCEEDS_USABLE_ALLOCATION");
  if (finitePositive(availableWmonMon) && finitePositive(entryBudgetMon) && n(entryBudgetMon) > n(availableWmonMon)) reasons.push("INSUFFICIENT_WMON_FOR_MARGIN_FEES_AND_BUFFER");
  if (currentOpenPositions.length >= n(maxConcurrentPositions)) reasons.push("MAX_CONCURRENT_POSITIONS_REACHED");
  const totalStopRisk = n(aggregateStopRiskMon) + Math.max(0, n(proposedStopRiskMon) || 0);
  if (totalStopRisk > n(maxAggregateStopRiskMon)) reasons.push("AGGREGATE_STOP_RISK_LIMIT_EXCEEDED");
  const proposedRisk = Math.max(0, n(proposedStopRiskMon) || 0);
  if (n(dailyRealizedLossMon) >= n(maxDailyRealizedLossMon) ||
      n(dailyRealizedLossMon) + proposedRisk > n(maxDailyRealizedLossMon)) reasons.push("DAILY_REALIZED_LOSS_LIMIT_REACHED_OR_PROJECTED");
  if (n(rollingDrawdownMon) >= n(maxRollingDrawdownMon) ||
      n(rollingDrawdownMon) + proposedRisk > n(maxRollingDrawdownMon)) reasons.push("ROLLING_DRAWDOWN_LIMIT_REACHED_OR_PROJECTED");
  return { allowed: reasons.length === 0, reasons, usableAllocationMon: usable, remainingAllocationMon: Math.max(0, usable - Math.max(0, n(requestedMarginMon) || 0)), aggregateStopRiskMon: totalStopRisk };
}
