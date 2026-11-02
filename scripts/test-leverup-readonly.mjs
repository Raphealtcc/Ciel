import assert from "node:assert/strict";
import {
  MIN_EXECUTION_LEVERAGE,
  assertMinimumLeverage,
  calculateMinimumCollateralMon,
  assertMarginBudget,
  buildLeverUpPreflight,
  normalizePositionAccrual,
  reconcileClosedPosition,
  estimateProtocolCosts,
  selectInferredLeverage,
  calculateNotionalFromMarginMon,
} from "../src/leverup-readonly.js";

const tiers = [
  { notionalUsdRaw: "20000000000000000000", tier: 0, maxLeverage: 100, initialLostPRaw: "0", liqLostPRaw: "0" },
  { notionalUsdRaw: "100000000000000000000", tier: 1, maxLeverage: 50, initialLostPRaw: "0", liqLostPRaw: "0" },
];
assert.equal(MIN_EXECUTION_LEVERAGE, 50);
assert.ok(Math.abs(calculateNotionalFromMarginMon({ marginMon: 22, leverage: 50, monUsdPrice: 0.026, collateralRatio: 0.7 }) - 20.02) < 1e-9);
assert.ok(Math.abs(calculateNotionalFromMarginMon({ marginMon: 11, leverage: 100, monUsdPrice: 0.026, collateralRatio: 0.7 }) - 20.02) < 1e-9);
assert.equal(selectInferredLeverage(100, 50, 100), 50);
assert.equal(selectInferredLeverage(75, 100, 100), 75);
assert.throws(() => selectInferredLeverage(25, 100, 100), /INFERENCE_BELOW_50X/);
assert.throws(() => selectInferredLeverage(100, 25, 100), /MARKET_MAX_LEVERAGE_BELOW_50X/);
assert.equal(assertMinimumLeverage({ requestedLeverage: 100, marketMaxLeverage: 100, leverageMargins: tiers, notionalUsd: 20n * 10n ** 18n }).tierMaxLeverage, 100);
assert.equal(assertMinimumLeverage({ requestedLeverage: 50, marketMaxLeverage: 50, leverageMargins: tiers, notionalUsd: 21n * 10n ** 18n }).tierMaxLeverage, 50);
assert.throws(() => assertMinimumLeverage({ requestedLeverage: 49, marketMaxLeverage: 100, leverageMargins: tiers, notionalUsd: 20n * 10n ** 18n }), /BELOW_50X/);
assert.throws(() => assertMinimumLeverage({ requestedLeverage: 50, marketMaxLeverage: 25, leverageMargins: tiers, notionalUsd: 20n * 10n ** 18n }), /MARKET_MAX_LEVERAGE_BELOW_50X/);
assert.throws(() => assertMinimumLeverage({ requestedLeverage: 100, marketMaxLeverage: 100, leverageMargins: tiers, notionalUsd: 21n * 10n ** 18n }), /EXCEEDS_NOTIONAL_TIER_MAX/);

const min50 = calculateMinimumCollateralMon({ minimumNotionalUsd: 20, leverage: 50, monUsdPrice: 0.019038, collateralRatio: 0.95 });
const min100 = calculateMinimumCollateralMon({ minimumNotionalUsd: 20, leverage: 100, monUsdPrice: 0.019038, collateralRatio: 0.95 });
assert.ok(min50 > 22 && min50 < 22.2);
assert.ok(min100 > 11 && min100 < 11.1);
assert.throws(() => calculateMinimumCollateralMon({ minimumNotionalUsd: 20, leverage: 25, monUsdPrice: 0.019, collateralRatio: 0.95 }), /INVALID_OR_UNVERIFIED/);
assert.throws(() => assertMarginBudget({ availableMarginMon: 20, requiredMinimumMon: min50, safetyBufferPct: 5 }), /INSUFFICIENT_MARGIN/);
assert.doesNotThrow(() => assertMarginBudget({ availableMarginMon: 30, requiredMinimumMon: min50, safetyBufferPct: 5 }));

const preflight = buildLeverUpPreflight({
  market: { symbol: "BTC", pairName: "BTC/USD", base: "0x1111111111111111111111111111111111111111", status: "AVAILABLE", minHoldingSeconds: 0 },
  pairView: { leverageMargins: tiers, feeConfig: { openFeeP: 3, closeFeeP: 3, enabled: true }, slippageConfig: { enabled: true }, longHoldingFeeRateRaw: "1000000", shortHoldingFeeRateRaw: "1000000" },
  marketInfo: { fundingFeeRate: "1000000000000000" },
  intendedNotionalUsd: 20, isLong: true, expectedHoldSeconds: 3600,
  oraclePriceRaw: "100000000000000000000000",
  monUsdPriceRaw: "19038000000000000",
  minimumNotionalRaw: "20000000000000000000",
  requestedLeverage: 100,
  availableMarginMon: 30,
  collateralRatio: 0.95,
  now: 1_800_000_000_000,
});
assert.equal(preflight.requestedLeverage, 100);
assert.equal(preflight.minimumNotionalUsd, 20);
assert.ok(preflight.estimatedCarryCosts);
assert.throws(() => buildLeverUpPreflight({
  market: { status: "AVAILABLE", minHoldingSeconds: 180, executionVenue: "POOL" },
  pairView: { leverageMargins: tiers, feeConfig: { openFeeP: 3, closeFeeP: 3, enabled: true }, longHoldingFeeRateRaw: "1000000", shortHoldingFeeRateRaw: "1000000" },
  marketInfo: { fundingFeeRate: "1000000000000000" },
  intendedNotionalUsd: 20, isLong: true, expectedHoldSeconds: 120,
  oraclePriceRaw: "1", monUsdPriceRaw: "1", minimumNotionalRaw: "20000000000000000000",
  requestedLeverage: 50, availableMarginMon: 100, collateralRatio: 1,
}), /MIN_HOLDING_DURATION_NOT_MET/);
assert.throws(() => buildLeverUpPreflight({
  market: { status: "AVAILABLE", minHoldingSeconds: 0, executionVenue: "HYPERLIQUID" },
  pairView: { leverageMargins: tiers },
  oraclePriceRaw: "1", monUsdPriceRaw: "1", minimumNotionalRaw: "20000000000000000000",
  requestedLeverage: 25, availableMarginMon: 100, collateralRatio: 1,
}), /BELOW_50X/);

const live = normalizePositionAccrual({
  positionHash: "0x" + "aa".repeat(32), pair: "BTC/USD",
  pairBase: "0x1111111111111111111111111111111111111111",
  isLong: true, marginToken: "0x2222222222222222222222222222222222222222",
  margin: 1000000000000000000n, openFee: 300000000000000n,
  executionFee: 0n, fundingFee: -1200000000000n, holdingFee: 500000000000n,
  accruedFundingFee: -1000000000000n, accruedHoldingFee: 400000000000n,
  earliestCloseTime: 0n, timestamp: 1790000000,
});
const settlement = reconcileClosedPosition({
  positionHash: live.positionHash, pair: "BTC/USD", status: "CLOSED",
  openFee: "300000000000000", closeInfo: {
    closeFee: "300000000000000", fundingFee: "-1500000000000",
    holdingFee: "700000000000", pnl: "5000000000000000",
    closePrice: "101000000000000000000000", closeTime: 1790000100,
  },
}, live, { estimatedProtocolCosts: { estimatedNetCostsUsd: 0.001 } }, { marginTokenDecimals: 18, marginTokenPriceUsd: 0.02 });
assert.equal(settlement.fundingSinceLastSnapshotRaw, "-300000000000");
assert.ok(settlement.actualNetCostsUsd > 0);
assert.ok(settlement.estimatedActualVarianceUsd !== null);
assert.equal(settlement.holdingSinceLastSnapshotRaw, "200000000000");
assert.equal(settlement.totalTradingFeesRaw, "600000000000000");
assert.equal(settlement.netPnlAfterFeesRaw, "4397800000000000");

const estimate = estimateProtocolCosts({
  notionalUsd: 1000, isLong: true, expectedHoldSeconds: 3600,
  pairView: { feeConfig: { enabled: true, openFeeP: 3, closeFeeP: 3 }, longHoldingFeeRateRaw: "1000000" },
  marketInfo: { fundingFeeRate: "1000000000000000" },
});
assert.equal(estimate.openFeeUsd, 0.3);
assert.equal(estimate.closeFeeUsd, 0.3);
assert.ok(estimate.holdingFeeUsd > 0);
assert.ok(estimate.fundingFeeUsd < 0);
console.log("PASS: 50x floor, dynamic tier gate, collateral minimum, cost estimates, live accrual reads, and settlement reconciliation.");
