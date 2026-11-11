// Independent portfolio risk gate for LeverUp. Fail closed on incomplete account/market data.
export const MIN_LEVERUP_RISK_LIMIT_MON = 20;
export const LEVERUP_RISK_DEFAULTS = Object.freeze({
  totalAllocationMon: 50, reserveMon: 25, minLeverage: 50,
  maxConcurrentPositions: 2, maxDailyRealizedLossMon: 20,
  maxRollingDrawdownMon: 20, maxAggregateStopRiskMon: 20,
  feeBufferPct: 25, slippageBufferPct: 25,
});

// Realized peak-to-trough drawdown is measured over a time window, not the
// last N trades indefinitely. Older losses age out without raising the cap.
export function calculateLeverUpRollingDrawdown(rows, now = Date.now(), windowHours = 48) {
  const hours = Number(windowHours);
  if (!Number.isFinite(hours) || hours <= 0) throw new Error("LEVERUP_ROLLING_DRAWDOWN_WINDOW_INVALID");
  const cutoffSeconds = Math.floor(Number(now) / 1000) - hours * 3600;
  const ordered = (Array.isArray(rows) ? rows : [])
    .filter((row) => Number(row?.close_time) >= cutoffSeconds)
    .sort((a, b) => Number(a.close_time) - Number(b.close_time));
  let equity = 0, peak = 0, drawdown = 0;
  for (const row of ordered) {
    let pnl;
    try { pnl = Number(BigInt(row?.net_pnl_after_fees_raw || "0")) / 1e18; }
    catch { continue; }
    if (!Number.isFinite(pnl)) continue;
    equity += pnl;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return drawdown;
}

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
export function evaluateLeverUpPortfolioRisk({ requestedLeverage, totalAllocationMon = 50, reserveMon = 25, availableCollateralMon, requestedMarginMon, entryBudgetMon, currentOpenPositions = [], maxConcurrentPositions = 2, proposedStopRiskMon, aggregateStopRiskMon = 0, maxAggregateStopRiskMon = 15, dailyRealizedLossMon = 0, maxDailyRealizedLossMon = 15, rollingDrawdownMon = 0, maxRollingDrawdownMon = 15, staleFeed = false, executionUncertain = false, killSwitchActive = true }) {
  const reasons = [];
  // Operator overrides may raise these limits, but cannot reduce any below 20 MON.
  const riskLimit = (value) => Number.isFinite(Number(value))
    ? Math.max(MIN_LEVERUP_RISK_LIMIT_MON, Number(value))
    : MIN_LEVERUP_RISK_LIMIT_MON;
  const aggregateStopRiskLimitMon = riskLimit(maxAggregateStopRiskMon);
  const dailyLossLimitMon = riskLimit(maxDailyRealizedLossMon);
  const drawdownLimitMon = riskLimit(maxRollingDrawdownMon);
  const n = (v) => Number(v);
  if (killSwitchActive) reasons.push("KILL_SWITCH_ACTIVE");
  if (staleFeed) reasons.push("STALE_MARKET_FEED");
  if (executionUncertain) reasons.push("EXECUTION_STATE_UNCERTAIN");
  if (!finitePositive(requestedLeverage) || n(requestedLeverage) < 50) reasons.push("LEVERAGE_BELOW_50X");
  if (!finitePositive(totalAllocationMon) || n(reserveMon) < 0 || n(reserveMon) >= n(totalAllocationMon)) reasons.push("INVALID_ALLOCATION_CONFIGURATION");
  const usable = Math.max(0, n(totalAllocationMon) - n(reserveMon));
  if (!finitePositive(availableCollateralMon)) reasons.push("AVAILABLE_LVMON_BALANCE_UNKNOWN");
  if (!finitePositive(requestedMarginMon)) reasons.push("REQUESTED_MARGIN_INVALID");
  const allocationCommitted = Math.max(finitePositive(requestedMarginMon) ? n(requestedMarginMon) : 0, finitePositive(entryBudgetMon) ? n(entryBudgetMon) : 0);
  if (allocationCommitted > usable) reasons.push("TRADE_EXCEEDS_USABLE_ALLOCATION");
  if (finitePositive(availableCollateralMon) && finitePositive(entryBudgetMon) && n(entryBudgetMon) > n(availableCollateralMon)) reasons.push("INSUFFICIENT_LVMON_FOR_MARGIN_FEES_AND_BUFFER");
  if (currentOpenPositions.length >= n(maxConcurrentPositions)) reasons.push("MAX_CONCURRENT_POSITIONS_REACHED");
  const totalStopRisk = n(aggregateStopRiskMon) + Math.max(0, n(proposedStopRiskMon) || 0);
  if (totalStopRisk > aggregateStopRiskLimitMon) reasons.push("AGGREGATE_STOP_RISK_LIMIT_EXCEEDED");
  const proposedRisk = Math.max(0, n(proposedStopRiskMon) || 0);
  if (n(dailyRealizedLossMon) >= dailyLossLimitMon ||
      n(dailyRealizedLossMon) + proposedRisk > dailyLossLimitMon) reasons.push("DAILY_REALIZED_LOSS_LIMIT_REACHED_OR_PROJECTED");
  if (n(rollingDrawdownMon) >= drawdownLimitMon ||
      n(rollingDrawdownMon) + proposedRisk > drawdownLimitMon) reasons.push("ROLLING_DRAWDOWN_LIMIT_REACHED_OR_PROJECTED");
  return { allowed: reasons.length === 0, reasons, usableAllocationMon: usable, allocationCommittedMon: allocationCommitted, remainingAllocationMon: Math.max(0, usable - allocationCommitted), aggregateStopRiskMon: totalStopRisk, riskLimitsMon: { dailyLoss: dailyLossLimitMon, drawdown: drawdownLimitMon, aggregateStopRisk: aggregateStopRiskLimitMon } };
}
