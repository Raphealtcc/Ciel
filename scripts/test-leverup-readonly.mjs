assert.equal(plan.actionValues[3].toLowerCase(), LV.toLowerCase(), "WMON collateral must use the protocol LV token field");\nimport assert from "node:assert/strict";
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
  hasAgentPermission,
  readAgentAuthorization,
  readLastAgentNonce,
  normalizePairView,
  buildMarketOpenPlan,
  LEVERUP_TOKENS,
} from "../src/leverup-readonly.js";

const tiers = [
  { notionalUsdRaw: "20000000000000000000", tier: 0, maxLeverage: 100, initialLostPRaw: "0", liqLostPRaw: "0" },
  { notionalUsdRaw: "100000000000000000000", tier: 1, maxLeverage: 50, initialLostPRaw: "0", liqLostPRaw: "0" },
];
assert.equal(MIN_EXECUTION_LEVERAGE, 50);
const pairView = normalizePairView({
  name: "BTC/USD", base: "0x1111111111111111111111111111111111111111",
  basePosition: 0, pairType: 0, status: 0, maxLongOiUsd: 1n, maxShortOiUsd: 2n,
  fundingFeePerSecondP: 3n, minFundingFeeR: 4n, maxFundingFeeR: 5n,
  leverageMargins: [{ notionalUsd: 20n * 10n ** 18n, tier: 0, maxLeverage: 100, initialLostP: 100, liqLostP: 200 }],
  slippageConfigIndex: 1, slippagePosition: 1,
  slippageConfig: { name: "Default", onePercentDepthAboveUsd: 10n, onePercentDepthBelowUsd: 11n, slippageLongP: 5, slippageShortP: 6, index: 1, slippageType: 0, enable: true, longThresholdUsd: 12n, shortThresholdUsd: 13n },
  feeConfigIndex: 0, feePosition: 0,
  feeConfig: { name: "Default", index: 0, openFeeP: 3, closeFeeP: 3, enable: true, shareP: 0, minCloseFeeP: 0, lvTokenDiscountP: 0 },
  longHoldingFeeRate: 951n, shortHoldingFeeRate: 951n,
  holdingTimeThresholdSizeUSD: 0n, minHoldingSeconds: 180n,
});
assert.equal(pairView.leverageMargins[0].maxLeverage, 100);
assert.equal(pairView.feeConfig.openFeeP, 3);
assert.equal(pairView.feeConfig.lvTokenDiscountP, 0);
assert.equal(pairView.minHoldingSeconds, 180);
const permissionMask = (1n << 0n) | (1n << 1n) | (1n << 9n);
assert.equal(hasAgentPermission(permissionMask, 0), true);
assert.equal(hasAgentPermission(permissionMask, 1), true);
assert.equal(hasAgentPermission(permissionMask, 9), true);
assert.equal(hasAgentPermission(permissionMask, 6), false);
assert.equal(hasAgentPermission((2n ** 256n) - 1n, 6), true);
const testTrader = "0x1111111111111111111111111111111111111111";
const testAgent = "0x2222222222222222222222222222222222222222";
const mockClient = {
  readContract: async ({ functionName }) => functionName === "getAgentAuth"
    ? { agent: testAgent, name: "0x" + "00".repeat(32), permissions: permissionMask, authorizedAt: 1790000000 }
    : 77n,
};
const authCheck = await readAgentAuthorization(testTrader, testAgent, { publicClient: mockClient });
assert.equal(authCheck.authorized, true);
assert.equal(authCheck.canMarketOpen, true);
assert.equal(authCheck.canPartialClose, true);
assert.equal(await readLastAgentNonce(testTrader, testAgent, { publicClient: mockClient }), 77n);
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
  pairView: { leverageMargins: tiers, minHoldingSeconds: 0, feeConfig: { openFeeP: 3, closeFeeP: 3, enabled: true }, slippageConfig: { enabled: true }, longHoldingFeeRateRaw: "1000000", shortHoldingFeeRateRaw: "1000000" },
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
  pairView: { leverageMargins: tiers, minHoldingSeconds: 180, feeConfig: { openFeeP: 3, closeFeeP: 3, enabled: true }, longHoldingFeeRateRaw: "1000000", shortHoldingFeeRateRaw: "1000000" },
  marketInfo: { fundingFeeRate: "1000000000000000" },
  intendedNotionalUsd: 20, isLong: true, expectedHoldSeconds: 120,
  oraclePriceRaw: "1", monUsdPriceRaw: "1", minimumNotionalRaw: "20000000000000000000",
  requestedLeverage: 50, availableMarginMon: 100, collateralRatio: 1,
}), /MIN_HOLDING_DURATION_NOT_MET/);
assert.throws(() => buildLeverUpPreflight({
  market: { status: "AVAILABLE", minHoldingSeconds: 0, executionVenue: "POOL" },
  pairView: { leverageMargins: tiers, minHoldingSeconds: 0 },
  expectedHoldSeconds: 0, isLong: true,
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

const WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A";
const LVMON = "0x91b81bfbe3A747230F0529Aa28d8b2Bc898E6D56";
const LV = "0x1001ff13bf368aa4fa85f21043648079f00e1001";
const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const wmonRaw = 100n * 10n ** 18n;
const planSnapshot = {
  traderAddress: testTrader,
  agentAddress: testAgent,
  collateralRatio: 1,
  market: { pairName: "BTC/USD", base: "0x3333333333333333333333333333333333333333", status: "AVAILABLE", executionVenue: "POOL", minHoldingSeconds: 0 },
  pairView: {
    base: "0x3333333333333333333333333333333333333333",
    leverageMargins: [
      { notionalUsdRaw: (20n * 10n ** 18n).toString(), maxLeverage: 100, tier: 0 },
      { notionalUsdRaw: (100n * 10n ** 18n).toString(), maxLeverage: 50, tier: 1 },
    ],
    minHoldingSeconds: 0,
    longHoldingFeeRateRaw: "1000000",
    shortHoldingFeeRateRaw: "1000000",
    feeConfig: { openFeeP: 3, closeFeeP: 3, enabled: true, minCloseFeeP: 0, lvTokenDiscountP: 5000 },
    slippageConfig: { enabled: true, slippageLongP: 5, slippageShortP: 5, slippageType: 0 },
  },
  marketInfo: { fundingFeeRate: "4000000000" },
  oraclePriceRaw: (1000n * 10n ** 18n).toString(),
  monUsdPriceRaw: (2n * 10n ** 16n).toString(),
  minimumNotionalRaw: (20n * 10n ** 18n).toString(),
  accountTokenStates: {
    [WMON.toLowerCase()]: { balance: wmonRaw.toString(), allowance: wmonRaw.toString() },
    [USDC.toLowerCase()]: { balance: (100n * 10n ** 6n).toString(), allowance: (100n * 10n ** 6n).toString() },
  },
  antiDdosConfig: {
    fetchedAt: Date.now(), validUntil: Date.now() + 60_000,
    config: [{ action: 0, enabled: true, priority: 0, feeToken: USDC, antiDdosFee: 1000n.toString() }],
  },
  agentAuthorization: { authorized: true, agentAddress: testAgent, canMarketOpen: true, canMarketClose: true, canPartialClose: true },
  lastAgentNonce: "77",
};
const discountedCollateralPlan = buildMarketOpenPlan({
  snapshot: { ...planSnapshot, collateralRatio: 0.8 },
  desiredMarginMon: 20, maxTradeMarginMon: 50,
  inferredLeverage: 100, side: "LONG", expectedHoldSeconds: 3600,
});
const discountedEffectiveMonPriceRaw = BigInt(planSnapshot.monUsdPriceRaw) * 8n * 10n ** 17n / (10n ** 18n);
const discountedOpenFeeUsdRaw = BigInt(planSnapshot.minimumNotionalRaw) * 3n / 10_000n;
const expectedDiscountedOpenFeeWmonRaw =
  (discountedOpenFeeUsdRaw * (10n ** 18n) + discountedEffectiveMonPriceRaw - 1n) / discountedEffectiveMonPriceRaw;
assert.equal(discountedCollateralPlan.openFeeTokenInRaw, expectedDiscountedOpenFeeWmonRaw.toString(),
  "WMON open fee must be converted using the collateral-ratio-adjusted MON price, not spot MON price");
assert.ok(BigInt(discountedCollateralPlan.openFeeTokenInRaw) >
  (discountedOpenFeeUsdRaw * (10n ** 18n) + BigInt(planSnapshot.monUsdPriceRaw) - 1n) / BigInt(planSnapshot.monUsdPriceRaw),
  "a discounted WMON collateral ratio must increase the WMON amount needed to cover the LVMON-denominated open fee");

const plan = buildMarketOpenPlan({
  snapshot: planSnapshot, desiredMarginMon: 20, maxTradeMarginMon: 50,
  inferredLeverage: 100, side: "LONG", expectedHoldSeconds: 3600,
});
assert.equal(plan.selectedLeverage, 100);
assert.equal(plan.notionalUsd, 20);
assert.equal(plan.marginMonUsed, "10");
assert.equal(plan.action, 0);
assert.ok(BigInt(plan.amountInRaw) > 10n * 10n ** 18n, "amountIn includes the open fee");
assert.equal(plan.feeToken.toLowerCase(), USDC.toLowerCase());
assert.equal(plan.nonce, (BigInt(Date.now()) > 78n ? plan.nonce : "78"));
assert.equal(plan.mode, "DRY_RUN_ONLY");
assert.equal(plan.protocolSlippageBps, "5");
assert.equal(plan.slippageBps, "30");
assert.equal(plan.worstPriceRaw, (1000n * 10n ** 18n * 10_030n / 10_000n).toString());
const protocolFloorPlan = buildMarketOpenPlan({ snapshot: planSnapshot, desiredMarginMon: 20, maxTradeMarginMon: 50, inferredLeverage: 100, side: "LONG", expectedHoldSeconds: 3600, entryPriceToleranceBps: 2 });
assert.equal(protocolFloorPlan.slippageBps, "5");
assert.throws(() => buildMarketOpenPlan({ snapshot: planSnapshot, desiredMarginMon: 20, maxTradeMarginMon: 50, inferredLeverage: 100, side: "LONG", expectedHoldSeconds: 3600, entryPriceToleranceBps: 101 }), /LIVE_ENTRY_PRICE_TOLERANCE_INVALID/);
assert.throws(() => buildMarketOpenPlan({ snapshot: { ...planSnapshot, pairView: { ...planSnapshot.pairView, slippageConfig: { ...planSnapshot.pairView.slippageConfig, slippageType: 1 } } }, desiredMarginMon: 20, maxTradeMarginMon: 50, inferredLeverage: 100, side: "LONG", expectedHoldSeconds: 3600 }), /LIVE_SLIPPAGE_TYPE_UNSUPPORTED/);

const roundingSnapshot = {
  ...planSnapshot,
  monUsdPriceRaw: "18178450000000000",
  minimumNotionalRaw: (20n * 10n ** 18n).toString(),
  collateralRatio: 20 / (100 * 0.23),
  pairView: {
    ...planSnapshot.pairView,
    leverageMargins: [{ notionalUsdRaw: (3_500_000n * 10n ** 18n).toString(), maxLeverage: 100, tier: 1 }],
  },
  accountTokenStates: {
    ...planSnapshot.accountTokenStates,
    [WMON.toLowerCase()]: { balance: (125n * 10n ** 18n).toString(), allowance: "0" },
  },
};
const exactMinimumMon = 0.23 / 0.01817845;
const roundedMinimumMon = Math.ceil(exactMinimumMon * 1e8) / 1e8;
const roundedMinimumPlan = buildMarketOpenPlan({
  snapshot: roundingSnapshot, desiredMarginMon: roundedMinimumMon, maxTradeMarginMon: 25,
  inferredLeverage: 100, side: "LONG", expectedHoldSeconds: 900,
  reserveMon: 25, requireExistingAllowance: false,
});
assert.ok(Number(roundedMinimumPlan.marginMonUsed) >= roundedMinimumMon);
assert.ok(roundedMinimumPlan.notionalUsd >= 20,
  "rounding minimum WMON upward must produce a valid $20+ notional plan");
assert.throws(() => buildMarketOpenPlan({
  snapshot: planSnapshot, desiredMarginMon: 5, maxTradeMarginMon: 50,
  inferredLeverage: 100, side: "LONG", expectedHoldSeconds: 3600,
}), /INSUFFICIENT_MARGIN_FOR_50X_PLUS_TIER_MINIMUM/);
assert.throws(() => buildMarketOpenPlan({
  snapshot: planSnapshot, desiredMarginMon: 20, maxTradeMarginMon: 50,
  inferredLeverage: 25, side: "LONG", expectedHoldSeconds: 3600,
}), /INFERENCE_BELOW_50X/);

const reserveTightSnapshot = {
  ...planSnapshot,
  accountTokenStates: {
    ...planSnapshot.accountTokenStates,
    [WMON.toLowerCase()]: {
      balance: (1001n * 10n ** 16n).toString(),
      allowance: (1001n * 10n ** 16n).toString(),
    },
  },
};
assert.throws(() => buildMarketOpenPlan({
  snapshot: reserveTightSnapshot, desiredMarginMon: 10, maxTradeMarginMon: 10,
  inferredLeverage: 100, side: "LONG", expectedHoldSeconds: 3600, reserveMon: 0.01,
}), /WMON_BALANCE_INSUFFICIENT_AFTER_RESERVE_FOR_MARGIN_AND_OPEN_FEE/);

const noAllowanceSnapshot = {
  ...planSnapshot,
  accountTokenStates: {
    ...planSnapshot.accountTokenStates,
    [WMON.toLowerCase()]: { balance: wmonRaw.toString(), allowance: "0" },
  },
};
assert.throws(() => buildMarketOpenPlan({
  snapshot: noAllowanceSnapshot, desiredMarginMon: 20, maxTradeMarginMon: 50,
  inferredLeverage: 100, side: "LONG", expectedHoldSeconds: 3600,
}), /WMON_DIAMOND_ALLOWANCE_INSUFFICIENT/);
const approvalReadyPlan = buildMarketOpenPlan({
  snapshot: noAllowanceSnapshot, desiredMarginMon: 20, maxTradeMarginMon: 50,
  inferredLeverage: 100, side: "LONG", expectedHoldSeconds: 3600, requireExistingAllowance: false,
});
assert.equal(approvalReadyPlan.mode, "DRY_RUN_ONLY");



// Direct native-MON collateral uses the documented native MON -> LVMON path,
// needs no ERC-20 allowance, and must reserve the requested native MON buffer.
const nativeSnapshot = {
  ...planSnapshot,
  collateralRatio: 1,
  nativeMonBalanceRaw: (54n * 10n ** 18n).toString(),
};
const nativePlan = buildMarketOpenPlan({
  snapshot: nativeSnapshot, desiredMarginMon: 24.5, maxTradeMarginMon: 25,
  inferredLeverage: 50, side: "LONG", expectedHoldSeconds: 900,
  reserveMon: 25, tokenIn: "0x0000000000000000000000000000000000000000",
  requireExistingAllowance: true,
});
assert.equal(nativePlan.mode, "ONCHAIN_NATIVE");
assert.equal(nativePlan.actionValues[2], "0x0000000000000000000000000000000000000000");
assert.equal(nativePlan.actionValues[3].toLowerCase(), LEVERUP_TOKENS.LVMON.toLowerCase());
assert.equal(nativePlan.feeToken, "0x0000000000000000000000000000000000000000");
assert.equal(nativePlan.antiDdosFee, 0n);

console.log("PASS: 50x floor, dynamic tier sizing, WMON+fee-token balance/allowance checks, amountIn/open-fee calculation, cost estimates, and settlement reconciliation.");
