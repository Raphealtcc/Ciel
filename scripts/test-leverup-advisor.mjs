import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { prepareLeverUpAdvisorPlan, formatLeverUpAdvisorLine } from "../src/leverup-advisor.js";
import { LEVERUP_TOKENS } from "../src/leverup-readonly.js";

const trader = "0x7aCd7C622a87a148CcdEBd213D7C4070E200186F";
const agent = "0xd422fc040ad9294d553150Cf5646Ab0B1729E443";
const wmon = LEVERUP_TOKENS.WMON.toLowerCase();
const baseSnapshot = (ratio) => ({
  checkedAt: 1_800_000_000_000, blockNumber: "123", traderAddress: trader, agentAddress: agent,
  market: { symbol: "BTC", pairName: "BTC/USD", base: "0x3333333333333333333333333333333333333333", status: "AVAILABLE", executionVenue: "POOL" },
  pairView: { leverageMargins: [{ notionalUsdRaw: (20n * 10n ** 18n).toString(), maxLeverage: 100, tier: 0 }], minHoldingSeconds: 60 },
  minimumNotionalRaw: (20n * 10n ** 18n).toString(),
  oraclePriceRaw: (1000n * 10n ** 18n).toString(), monUsdPriceRaw: (19038n * 10n ** 12n).toString(),
  accountTokenStates: { [wmon]: { balance: (50n * 10n ** 18n).toString(), allowance: (50n * 10n ** 18n).toString() } },
  indexedPositions: [], agentAuthorization: { authorized: true, canMarketOpen: true, canMarketClose: true, canPartialClose: true },
  collateralRatio: ratio,
});
const env = {
  LEVERUP_PREFLIGHT_ENABLED: "true", LEVERUP_LIVE_TRADING: "false", LEVERUP_KILL_SWITCH: "true",
  LEVERUP_MIN_LEVERAGE: "50", LEVERUP_TOTAL_ALLOCATION_MON: "50", LEVERUP_RESERVE_MON: "25",
  LEVERUP_TRADER_ADDRESS: trader, LEVERUP_AGENT_ADDRESS: agent,
  CIEL_STATE: { put: async () => {} }, DB: { prepare: () => ({}) },
};
const candidate = { symbol: "BTC", side: "LONG", stopPct: 0.4, targetPct: 0.64, holdMinutes: 180, mode: "TREND_HOLD" };
const advisorSource = await readFile(new URL("../src/leverup-advisor.js", import.meta.url), "utf8");
assert.ok(advisorSource.includes("Number(plan.marginMonUsed) * Number(plan.selectedLeverage) * stopPct / 100"),
  "LeverUp stop-risk must include the actual leverage multiplier");
const reviewed = { verdict: "APPROVE", paperMarginMon: 11.5 };
let seenPlanArgs = null, seenPersist = null;
const dependencies = {
  readSnapshot: async ({ collateralRatio }) => baseSnapshot(collateralRatio),
  buildPlan: (args) => {
    seenPlanArgs = args;
    return {
      selectedLeverage: 100, tierMaxLeverage: 100, marginMonUsed: String(args.desiredMarginMon),
      notionalUsd: 20, preflight: {
        requestedLeverage: 100, marketMaxLeverage: 100, maxLeverageForNotional: 100, checkedAt: args.now,
        pair: "BTC/USD", pairBase: "0x3333333333333333333333333333333333333333",
        notionalUsdRaw: "20000000000000000000", oraclePriceRaw: "1000000000000000000000",
        monUsdPriceRaw: "19038000000000000", collateralRatio: 0.95, minimumCollateralMon: 11.0,
        marginBudget: { availableMarginMon: 25 }, protocolFeeConfig: {}, slippageConfig: {},
        marketInfo: {}, longHoldingFeeRateRaw: "0", shortHoldingFeeRateRaw: "0",
        estimatedProtocolCosts: { openFeeUsd: 0.006, holdingFeeUsd: 0.001, fundingFeeUsd: 0.002 },
      },
    };
  },
  persistPreflight: async (_db, signalId, preflight, options) => {
    seenPersist = { signalId, preflight, options }; return "ledger-id";
  },
};
const noRatio = await prepareLeverUpAdvisorPlan({
  env: { ...env }, candidate, reviewed, signalId: "SIG-NO-RATIO", now: 1_800_000_000_000,
  dependencies: { readSnapshot: async ({ collateralRatio }) => baseSnapshot(collateralRatio) },
});
assert.equal(noRatio.status, "BLOCKED_COLLATERAL_RATIO_UNVERIFIED");
assert.equal(noRatio.account.wmonBalanceMon, "50.0000");

const ready = await prepareLeverUpAdvisorPlan({
  env: { ...env, LEVERUP_WMON_COLLATERAL_RATIO: "0.95" }, candidate, reviewed,
  signalId: "SIG-READY", now: 1_800_000_000_000, dependencies,
});
assert.equal(ready.status, "PREFLIGHT_PASS_LIVE_DISABLED");
assert.equal(ready.liveExecutionEnabled, false);
assert.equal(ready.killSwitchEnabled, true);
assert.equal(ready.selectedLeverage, 100);
assert.ok(seenPlanArgs.desiredMarginMon >= ready.minimumMarginMon);
assert.equal(seenPlanArgs.maxTradeMarginMon, ready.minimumMarginMon, "unset per-trade cap defaults to venue minimum only");
assert.equal(seenPlanArgs.reserveMon, 25);
assert.ok(seenPlanArgs.stopLossPriceRaw > 0n && seenPlanArgs.takeProfitPriceRaw > 0n);
assert.equal(seenPersist.options.decision, "PASS");
assert.equal(ready.ledgerPersisted, true);
assert.ok(formatLeverUpAdvisorLine(ready).includes("DRY RUN ONLY"));

const below50 = await prepareLeverUpAdvisorPlan({
  env: { ...env, LEVERUP_WMON_COLLATERAL_RATIO: "0.95" }, candidate: { ...candidate, leverage: 25 },
  reviewed, signalId: "SIG-25", now: 1_800_000_000_000, dependencies,
});
assert.equal(below50.status, "BLOCKED_PREFLIGHT");
assert.match(below50.reason, /BELOW_50X/);

const existing = await prepareLeverUpAdvisorPlan({
  env: { ...env, LEVERUP_WMON_COLLATERAL_RATIO: "0.95" }, candidate, reviewed,
  signalId: "SIG-OPEN", now: 1_800_000_000_000,
  dependencies: { readSnapshot: async ({ collateralRatio }) => ({ ...baseSnapshot(collateralRatio), indexedPositions: [{ positionHash: "0xabc" }] }) },
});
assert.equal(existing.status, "BLOCKED_EXISTING_POSITION");

const notApproved = await prepareLeverUpAdvisorPlan({
  env: { ...env, LEVERUP_WMON_COLLATERAL_RATIO: "0.95" }, candidate, reviewed: { verdict: "WAIT" },
  signalId: "SIG-WAIT", now: 1_800_000_000_000, dependencies,
});
assert.equal(notApproved.status, "NOT_APPROVED");


import { runLeverUpDiagnostics } from "../src/leverup-advisor.js";
import { privateKeyToAccount } from "viem/accounts";
const diagKey = `0x${"02".repeat(32)}`;
const diagAgent = privateKeyToAccount(diagKey).address;
const diag = await runLeverUpDiagnostics({
  env: { ...env, LEVERUP_TRADER_PRIVATE_KEY: "0x" + "03".repeat(32),
    LEVERUP_TRADER_ADDRESS: privateKeyToAccount("0x" + "03".repeat(32)).address,
    LEVERUP_AGENT_PRIVATE_KEY: diagKey, LEVERUP_AGENT_ADDRESS: diagAgent,
    LEVERUP_LIVE_TRADING: "false", LEVERUP_KILL_SWITCH: "true" },
  now: Date.now(),
  dependencies: { readSnapshot: async () => ({
    market: { base: "0x3333333333333333333333333333333333333333" },
    agentAuthorization: { authorized: true, agentAddress: diagAgent,
      canMarketOpen: true, canMarketClose: true, canPartialClose: true },
    lastAgentNonce: "0", blockNumber: "123", indexedPositions: [], onchainPositions: [],
    accountTokenStates: { [wmon]: { balance: "1000000000000000000", allowance: "1000000000000000000" } },
  }) },
});
assert.equal(diag.ok, true);
assert.equal(diag.signing.status, "PASS");
assert.equal(diag.signerMatchesConfiguredAgent, true);
assert.equal(diag.traderSignerMatchesConfiguredWallet, true);
assert.equal(diag.traderSigning.status, "PASS");
assert.equal(diag.orderSubmitted, false);
assert.equal(JSON.stringify(diag).includes(diagKey), false);
console.log("PASS: CIEL-to-LeverUp preflight is read-only, 50x-minimum, reserve-aware, approval-gated, existing-position-safe, ledger-backed, and hard-locked from live execution, with read-only wallet and synthetic signer diagnostics.");
