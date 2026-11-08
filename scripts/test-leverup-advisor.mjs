import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { prepareLeverUpAdvisorPlan, formatLeverUpAdvisorLine, leverUpUsdLimitsToMon, buildBudgetedLeverUpPlan } from "../src/leverup-advisor.js";
import { LEVERUP_TOKENS } from "../src/leverup-readonly.js";
import { privateKeyToAccount } from "viem/accounts";

const testTraderKey = "0x" + "0".repeat(63) + "1";
const trader = privateKeyToAccount(testTraderKey).address;
const testAgentKey = "0x" + "0".repeat(63) + "2";
const agent = privateKeyToAccount(testAgentKey).address;
const wmon = LEVERUP_TOKENS.WMON.toLowerCase();
const baseSnapshot = (ratio) => ({
  checkedAt: 1_800_000_000_000, blockNumber: "123", traderAddress: trader, agentAddress: agent,
  market: { symbol: "BTC", pairName: "BTC/USD", base: "0x3333333333333333333333333333333333333333", status: "AVAILABLE", executionVenue: "POOL" },
  pairView: { leverageMargins: [{ notionalUsdRaw: (20n * 10n ** 18n).toString(), maxLeverage: 100, tier: 0 }], minHoldingSeconds: 60 },
  minimumNotionalRaw: (20n * 10n ** 18n).toString(),
  nativeMonBalanceRaw: (50n * 10n ** 18n).toString(), nativeMonBalanceMon: 50,
  oraclePriceRaw: (1000n * 10n ** 18n).toString(), monUsdPriceRaw: (19038n * 10n ** 12n).toString(),
  accountTokenStates: { [wmon]: { balance: (50n * 10n ** 18n).toString(), allowance: (50n * 10n ** 18n).toString() } },
  indexedPositions: [], agentAuthorization: { authorized: true, agentAddress: agent, canMarketOpen: true, canMarketClose: true, canPartialClose: true },
  collateralRatio: ratio,
});
const env = {
  LEVERUP_PREFLIGHT_ENABLED: "true", LEVERUP_LIVE_TRADING: "false", LEVERUP_KILL_SWITCH: "true",
  LEVERUP_MIN_LEVERAGE: "50",
  LEVERUP_TOTAL_ALLOCATION_USD: "0.9129835", LEVERUP_RESERVE_USD: "0.45649175",
  LEVERUP_MAX_TRADE_MARGIN_USD: "0.45649175", LEVERUP_MIN_TRADE_MARGIN_USD: "0.23737571",
  LEVERUP_COLLATERAL_50X_USD: "0.43", LEVERUP_COLLATERAL_100X_USD: "0.23",
  LEVERUP_TRADER_ADDRESS: trader, LEVERUP_TRADER_PRIVATE_KEY: testTraderKey, LEVERUP_AGENT_ADDRESS: agent,
  LEVERUP_AGENT_PRIVATE_KEY: testAgentKey,
  CIEL_STATE: { put: async () => {} }, DB: { prepare: () => ({ bind() { return this; }, first: async () => null }) },
};
const candidate = { symbol: "BTC", side: "LONG", confidence: 0.82, stopPct: 0.4, targetPct: 0.64, holdMinutes: 180, mode: "TREND_HOLD" };
const advisorSource = await readFile(new URL("../src/leverup-advisor.js", import.meta.url), "utf8");
assert.ok(advisorSource.includes("Number(plan.marginMonUsed) * Number(plan.selectedLeverage) * stopPct / 100"),
  "LeverUp stop-risk must include the actual leverage multiplier");
const reviewed = { verdict: "APPROVE", paperMarginMon: 1, liveMarginMon: 12 };
let seenPlanArgs = null, seenPersist = null;
const dependencies = {
  readSnapshot: async ({ collateralRatio }) => baseSnapshot(collateralRatio),
  buildPlan: (args) => {
    seenPlanArgs = args;
    return {
      selectedLeverage: 100, tierMaxLeverage: 100, marginMonUsed: String(args.desiredMarginMon),
      amountInRaw: BigInt(Math.ceil(Number(args.desiredMarginMon) * 1.014 * 1e18)).toString(),
      feeToken: "0x0000000000000000000000000000000000000000", antiDdosFee: "0",
      nonce: String(args.now), deadline: Math.floor(args.now / 1000) + 300,
      actionValues: [args.snapshot.market.base, true, LEVERUP_TOKENS.WMON, LEVERUP_TOKENS.LVMON,
        BigInt(Math.ceil(Number(args.desiredMarginMon) * 1.014 * 1e18)), 10000000000n,
        BigInt(args.snapshot.oraclePriceRaw), args.stopLossPriceRaw, args.takeProfitPriceRaw, 0, 0n],
      notionalUsd: 20, preflight: {
        preflightPassed: true, status: "AVAILABLE", requestedLeverage: 100,
        marketMaxLeverage: 100, maxLeverageForNotional: 100, checkedAt: args.now,
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
const collateral50 = (await import("../src/leverup-advisor.js")).leverUpCollateralUsdForLeverage;
assert.equal(collateral50({ leverage: 50, minimumNotionalUsd: 20 }), 0.43);
assert.equal(collateral50({ leverage: 75, minimumNotionalUsd: 20 }), 0.33);
assert.equal(collateral50({ leverage: 100, minimumNotionalUsd: 20 }), 0.23);
assert.equal(collateral50({ leverage: 150, minimumNotionalUsd: 20 }), 0.23);
const limitsAtReference = leverUpUsdLimitsToMon({ env, monUsdPrice: 0.01825967 });
assert.equal(limitsAtReference.totalAllocationMon, 50);
assert.equal(limitsAtReference.reserveMon, 25);
assert.equal(limitsAtReference.maxTradeMarginMon, 25);
assert.equal(limitsAtReference.minimumTradeMarginMon, 13);
const limitsAfterPriceRise = leverUpUsdLimitsToMon({ env, monUsdPrice: 0.03651934 });
assert.equal(limitsAfterPriceRise.totalAllocationMon, 25);
assert.equal(limitsAfterPriceRise.reserveMon, 12.5);
assert.equal(limitsAfterPriceRise.maxTradeMarginMon, 12.5);
assert.equal(limitsAfterPriceRise.minimumTradeMarginMon, 6.5);
const fixedMonOverrides = { ...env, LEVERUP_TOTAL_ALLOCATION_MON: "50", LEVERUP_RESERVE_MON: "25", LEVERUP_MAX_TRADE_MARGIN_MON: "25" };
const fixedMonAtReference = leverUpUsdLimitsToMon({ env: fixedMonOverrides, monUsdPrice: 0.01825967 });
const fixedMonAfterPriceRise = leverUpUsdLimitsToMon({ env: fixedMonOverrides, monUsdPrice: 0.03651934 });
for (const fixed of [fixedMonAtReference, fixedMonAfterPriceRise]) {
  assert.equal(fixed.totalAllocationMon, 50, "explicit MON allocation override must remain fixed");
  assert.equal(fixed.reserveMon, 25, "explicit MON reserve override must remain fixed");
  assert.equal(fixed.maxTradeMarginMon, 25, "explicit MON trade ceiling must remain fixed");
}
const budgetProbe = buildBudgetedLeverUpPlan({
  buildPlan: ({ desiredMarginMon }) => ({
    marginMonUsed: String(desiredMarginMon),
    amountInRaw: BigInt(Math.ceil(desiredMarginMon * 1.014 * 1e18)).toString(),
    feeToken: "0x0000000000000000000000000000000000000000", antiDdosFee: "0",
  }),
  planArgs: { desiredMarginMon: 25.15 }, maxEntryBudgetMon: 25.15, minimumMarginMon: 13,
});
assert.ok(Number(budgetProbe.plan.marginMonUsed) < 25.15,
  "planner must reduce margin to make room for the actual open fee");
assert.ok(Number(budgetProbe.entryBudgetMon) <= 25.15,
  "margin plus open fee must fit within the configured entry allocation");
assert.throws(() => buildBudgetedLeverUpPlan({
  buildPlan: ({ desiredMarginMon }) => ({
    marginMonUsed: String(desiredMarginMon), amountInRaw: (30n * 10n ** 18n).toString(),
    feeToken: "0x0000000000000000000000000000000000000000", antiDdosFee: "0",
  }),
  planArgs: { desiredMarginMon: 25 }, maxEntryBudgetMon: 25, minimumMarginMon: 13,
}), /MINIMUM_MARGIN_PLUS_ENTRY_COSTS/);
assert.equal(collateral50({ leverage: 75, minimumNotionalUsd: 40 }), 0.66);
assert.throws(() => collateral50({ leverage: 25, minimumNotionalUsd: 20 }), /SCHEDULE_INPUT_INVALID/);

const ready = await prepareLeverUpAdvisorPlan({
  env: { ...env }, candidate, reviewed,
  signalId: "SIG-READY", now: 1_800_000_000_000, dependencies,
});
assert.equal(ready.status, "PREFLIGHT_PASS_LIVE_DISABLED");
const lowScoreReady = await prepareLeverUpAdvisorPlan({
  env: { ...env }, candidate: { ...candidate, confidence: 0.01 }, reviewed,
  signalId: "SIG-LOW-SCORE", now: 1_800_000_000_001, dependencies,
});
assert.equal(lowScoreReady.status, "PREFLIGHT_PASS_LIVE_DISABLED",
  "a valid low technical score must not be blocked from LeverUp preflight");
assert.equal(ready.liveExecutionEnabled, false);
assert.equal(ready.killSwitchEnabled, true);
assert.equal(ready.selectedLeverage, 100);
assert.equal(seenPlanArgs.tokenIn.toLowerCase(), wmon,
  "hosted-agent 1CT planning must use the ERC-20 WMON collateral route");
assert.equal(ready.dryRunSigning.signed, true,
  "dry-run must locally verify the hosted-agent EIP-712 signature without submitting an intent");
assert.equal(ready.coordination.status, "DRY_RUN_APPROVED",
  "dry-run portfolio checks must use the WMON balance and remain non-submitting");
assert.equal(ready.minimumCollateralUsd, 0.23,
  "100x live advisor sizing must use the configured $0.23 LVMON collateral target");
assert.equal(ready.minimumNotionalUsd, 20);
assert.equal(ready.bufferedMinimumNotionalUsd, 21,
  "the default 5% headroom must lift a $20 venue minimum to $21");
assert.equal(ready.minimumNotionalBufferBps, 500);
assert.ok(Math.abs(ready.collateralRatio - (21 / (100 * 0.23))) < 1e-12,
  "100x collateral ratio must encode 5% notional headroom without increasing the configured collateral target");
assert.ok(Math.abs((21 / (50 * 0.43)) - 0.9767441860465116) < 1e-12,
  "50x HYPE sizing must also have headroom while retaining the $0.43 collateral target");
assert.ok(Math.abs(ready.venueMinimumMarginMon - (0.23 / 0.019038)) < 1e-6,
  "100x minimum collateral must convert the $0.23 target using the fresh MON/USD oracle");
assert.ok(Math.abs(ready.minimumMarginMon - (0.23 / 0.019038)) < 1e-6,
  "the 100x minimum collateral must be exactly the configured $0.23 target; the legacy generic margin floor must not override it");
const expectedLiveMarginMon = Math.max(12, ready.minimumMarginMon);
assert.equal(seenPlanArgs.desiredMarginMon, Math.ceil(ready.minimumMarginMon * 1e8) / 1e8,
  "minimum margin passed to the plan must round upward to avoid floating-point underfunding");
assert.ok(Math.abs(seenPlanArgs.desiredMarginMon - expectedLiveMarginMon) < 1e-9,
  "LeverUp must use its independent live margin proposal, clamped only to the venue minimum collateral");
assert.ok(seenPlanArgs.desiredMarginMon > reviewed.paperMarginMon,
  "LeverUp sizing must not inherit the smaller paper margin");
assert.ok(Math.abs(seenPlanArgs.maxTradeMarginMon - (0.45649175 / 0.019038)) < 1e-6,
  "live margin ceiling must convert the fixed USD cap using the fresh MON/USD oracle");
assert.ok(Math.abs(seenPlanArgs.reserveMon - (0.45649175 / 0.019038)) < 1e-6);
assert.ok(Math.abs(ready.totalAllocationMon - (0.9129835 / 0.019038)) < 1e-6);
assert.ok(seenPlanArgs.stopLossPriceRaw > 0n && seenPlanArgs.takeProfitPriceRaw > 0n);
assert.equal(seenPersist.options.decision, "PASS");
assert.equal(ready.ledgerPersisted, true);

const liveWithoutExplicitEntryGrant = await prepareLeverUpAdvisorPlan({
  env: { ...env, LEVERUP_LIVE_TRADING: "true", LEVERUP_KILL_SWITCH: "false" },
  candidate, reviewed, signalId: "SIG-LIVE-NO-D1-GRANT",
  now: 1_800_000_000_000, dependencies,
});
assert.equal(liveWithoutExplicitEntryGrant.status, "BLOCKED_SAFETY_CONFIGURATION",
  "live environment flags alone must not enable entries without an explicit D1 grant");
assert.equal(liveWithoutExplicitEntryGrant.liveExecutionEnabled, false);

assert.ok(formatLeverUpAdvisorLine(ready).includes("DRY RUN"),
  "compact LeverUp output must identify dry-run mode");
assert.ok(formatLeverUpAdvisorLine({status:"PREFLIGHT_PASS_LIVE_ENABLED",selectedLeverage:50,marginMonUsed:26.19,notionalUsd:20.92,liveExecutionEnabled:true,coordination:{status:"REJECTED",reason:"insufficient transfers"}}).includes("NOT OPENED · insufficient transfers"), "rejected execution must not be shown as a preflight-only pass");
assert.ok(formatLeverUpAdvisorLine({status:"PREFLIGHT_PASS_LIVE_ENABLED",selectedLeverage:50,marginMonUsed:26.19,notionalUsd:20.92,liveExecutionEnabled:true,coordination:{status:"SUBMITTED",submitted:true}}).includes("awaiting on-chain confirmation"), "submitted must be distinguished from a confirmed position");
assert.ok(formatLeverUpAdvisorLine({status:"PREFLIGHT_PASS_LIVE_ENABLED",selectedLeverage:50,marginMonUsed:26.19,notionalUsd:20.92,liveExecutionEnabled:true,coordination:{status:"RECONCILED",positions:[{positionHash:"0xabc"}]}}).includes("POSITION OPEN"), "an open position requires reconciliation");
assert.ok(formatLeverUpAdvisorLine({status:"PREFLIGHT_PASS_LIVE_ENABLED",selectedLeverage:50,marginMonUsed:24.5,notionalUsd:20.92,liveExecutionEnabled:true,coordination:{status:"EXECUTED",positionHash:"0x"+"ab".repeat(32)}}).includes("POSITION OPEN"), "direct onchain execution must report open only when a position hash is confirmed");
assert.equal(formatLeverUpAdvisorLine(ready).split("\n").length, 1,
  "LeverUp suggestion output must stay on one concise line");
assert.ok(formatLeverUpAdvisorLine(ready).length <= 100,
  "LeverUp status must remain concise; detailed portfolio-risk diagnostics stay outside the trade alert");

const below50 = await prepareLeverUpAdvisorPlan({
  env: { ...env }, candidate: { ...candidate, leverage: 25 },
  reviewed, signalId: "SIG-25", now: 1_800_000_000_000, dependencies,
});
assert.equal(below50.status, "BLOCKED_PREFLIGHT");
assert.match(below50.reason, /BELOW_50X/);

const oneExistingPosition = await prepareLeverUpAdvisorPlan({
  env: { ...env }, candidate, reviewed,
  signalId: "SIG-ONE-OPEN", now: 1_800_000_000_000,
  dependencies: { ...dependencies, readSnapshot: async ({ collateralRatio }) => ({ ...baseSnapshot(collateralRatio), indexedPositions: [{ positionHash: "0xabc" }] }) },
});
assert.equal(oneExistingPosition.status, "PREFLIGHT_PASS_LIVE_DISABLED",
  "one existing position must leave the second configured slot available");
assert.equal(oneExistingPosition.coordination.status, "DRY_RUN_APPROVED",
  "portfolio risk checks must allow one existing position when the concurrency limit is two");

const atPositionLimit = await prepareLeverUpAdvisorPlan({
  env: { ...env }, candidate, reviewed,
  signalId: "SIG-TWO-OPEN", now: 1_800_000_000_000,
  dependencies: { readSnapshot: async ({ collateralRatio }) => ({ ...baseSnapshot(collateralRatio),
    indexedPositions: [{ positionHash: "0xabc" }, { positionHash: "0xdef" }] }) },
});
assert.equal(atPositionLimit.status, "BLOCKED_MAX_CONCURRENT_POSITIONS");
assert.equal(atPositionLimit.maxConcurrentPositions, 2,
  "the configured two-position limit must remain enforced");

const missingPositionIndex = await prepareLeverUpAdvisorPlan({
  env: { ...env }, candidate, reviewed,
  signalId: "SIG-POSITIONS-UNKNOWN", now: 1_800_000_000_000,
  dependencies: { readSnapshot: async ({ collateralRatio }) => {
    const snapshot = baseSnapshot(collateralRatio); delete snapshot.indexedPositions; return snapshot;
  } },
});
assert.equal(missingPositionIndex.status, "BLOCKED_POSITION_SNAPSHOT_UNAVAILABLE",
  "unknown position state must fail closed");

const notApproved = await prepareLeverUpAdvisorPlan({
  env: { ...env }, candidate, reviewed: { verdict: "WAIT" },
  signalId: "SIG-WAIT", now: 1_800_000_000_000, dependencies,
});
assert.equal(notApproved.status, "NOT_APPROVED");

const belowScore = await prepareLeverUpAdvisorPlan({
  env: { ...env }, candidate: { ...candidate, confidence: 0.7799 }, reviewed,
  signalId: "SIG-SCORE-77", now: 1_800_000_000_000, dependencies,
});
assert.equal(belowScore.status, "PREFLIGHT_PASS_LIVE_DISABLED");
assert.ok(Math.abs(belowScore.technicalScore - 77.99) < 1e-9 || belowScore.technicalScore === undefined,
  "a valid 77.99/100 score must pass preflight without a numerical floor");

const atScoreFloor = await prepareLeverUpAdvisorPlan({
  env: { ...env }, candidate: { ...candidate, confidence: 0.78 }, reviewed,
  signalId: "SIG-SCORE-78", now: 1_800_000_000_000, dependencies,
});
assert.equal(atScoreFloor.status, "PREFLIGHT_PASS_LIVE_DISABLED",
  "a score of exactly 78/100 must pass the score gate and continue through the existing checks");


import { runLeverUpDiagnostics } from "../src/leverup-advisor.js";

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
    accountTokenStates: Object.fromEntries(Object.values(LEVERUP_TOKENS).map((token) =>
      [token.toLowerCase(), { balance: "1000000000000000000", allowance: "1000000000000000000" }])),
  }),
    runMarketPreflights: async () => Object.fromEntries(["BTC","ETH","SOL"].map((symbol) => [symbol,{status:"PASS",symbol,selectedLeverage:100,minimumMarginMon:1,orderSubmitted:false,approvalTransactionSubmitted:false}])),
    verifyCoordinator: async () => ({status:"PASS",orderSubmitted:false,intentClaimed:true,duplicateBlocked:true,statusReconciled:true}),
  },
});
assert.equal(diag.ok, true);
assert.equal(diag.signing.status, "PASS");
assert.equal(diag.signerMatchesConfiguredAgent, true);
assert.equal(diag.traderSignerMatchesConfiguredWallet, true);
assert.equal(diag.traderSigning.status, "PASS");
assert.equal(diag.orderSubmitted, false);
assert.deepEqual(Object.keys(diag.marketPreflights).sort(), ["BTC","ETH","SOL"]);
assert.equal(diag.coordinator.status, "PASS");
assert.equal(JSON.stringify(diag).includes(diagKey), false);

let scopedSnapshotSymbol = null, scopedMarketSymbols = null, coordinatorCalls = 0;
const scoped = await runLeverUpDiagnostics({
  env: { ...env, LEVERUP_TRADER_PRIVATE_KEY: "0x" + "03".repeat(32),
    LEVERUP_TRADER_ADDRESS: privateKeyToAccount("0x" + "03".repeat(32)).address,
    LEVERUP_AGENT_PRIVATE_KEY: diagKey, LEVERUP_AGENT_ADDRESS: diagAgent,
    LEVERUP_LIVE_TRADING: "false", LEVERUP_KILL_SWITCH: "true" },
  now: Date.now(), symbols: ["ETH"], skipCoordinator: true,
  dependencies: {
    readSnapshot: async ({ symbol }) => { scopedSnapshotSymbol = symbol; return {
      market: { symbol, base: "0x3333333333333333333333333333333333333333" },
      agentAuthorization: { authorized: true, agentAddress: diagAgent, canMarketOpen: true, canMarketClose: true, canPartialClose: true },
      lastAgentNonce: "0", blockNumber: "124", indexedPositions: [], onchainPositions: [],
      accountTokenStates: Object.fromEntries(Object.values(LEVERUP_TOKENS).map((token) => [token.toLowerCase(), { balance: "1000000000000000000", allowance: "1000000000000000000" }])),
    }; },
    runMarketPreflights: async ({ symbols }) => { scopedMarketSymbols = symbols; return { ETH: { status: "PASS", symbol: "ETH" } }; },
    verifyCoordinator: async () => { coordinatorCalls++; return { status: "PASS" }; },
  },
});
assert.equal(scopedSnapshotSymbol, "ETH");
assert.deepEqual(scopedMarketSymbols, ["ETH"]);
assert.equal(scoped.coordinator.status, "SKIPPED");
assert.equal(coordinatorCalls, 0);
assert.equal(scoped.ok, true);

const liveDiag = await runLeverUpDiagnostics({
  env: { ...env, LEVERUP_LIVE_TRADING: "true", LEVERUP_KILL_SWITCH: "false",
    LEVERUP_TRADER_PRIVATE_KEY: "0x" + "03".repeat(32),
    LEVERUP_TRADER_ADDRESS: privateKeyToAccount("0x" + "03".repeat(32)).address,
    LEVERUP_AGENT_PRIVATE_KEY: diagKey, LEVERUP_AGENT_ADDRESS: diagAgent },
  now: Date.now(), symbols: ["ETH"], skipCoordinator: true,
  dependencies: {
    readSnapshot: async ({symbol}) => ({
      market:{symbol,base:"0x3333333333333333333333333333333333333333"},
      agentAuthorization:{authorized:true,agentAddress:diagAgent,canMarketOpen:true,canMarketClose:true,canPartialClose:true},
      lastAgentNonce:"0",blockNumber:"125",indexedPositions:[],onchainPositions:[],
      accountTokenStates:Object.fromEntries(Object.values(LEVERUP_TOKENS).map(token=>[token.toLowerCase(),{balance:"1000000000000000000",allowance:"1000000000000000000"}]))
    }),
    runMarketPreflights: async () => ({ETH:{status:"PASS",symbol:"ETH",orderSubmitted:false,approvalTransactionSubmitted:false}})
  }
});
assert.equal(liveDiag.ok,true);
assert.equal(liveDiag.mode,"LIVE_READ_ONLY_PREFLIGHT");
assert.equal(liveDiag.liveTradingEnabled,true);
assert.equal(liveDiag.killSwitchActive,false);
assert.equal(liveDiag.orderSubmitted,false);
assert.equal(liveDiag.coordinator.status,"SKIPPED");

console.log("PASS: CIEL-to-LeverUp preflight is read-only, 50x-minimum, reserve-aware, approval-gated, existing-position-safe, ledger-backed, and hard-locked from live execution, with read-only wallet and synthetic signer diagnostics.");

const integrationPatch = await readFile(new URL("./apply-leverup-integration.mjs", import.meta.url), "utf8");
assert.ok(integrationPatch.includes("compactCielSetupMessage"), "trade alerts must use the compact suggestion formatter");
assert.ok(integrationPatch.includes("compactCielSetupMessage(position, candidate, reviewed, monUsdPrice, forecast)"), "the notification must actually call the compact formatter");
assert.ok(integrationPatch.includes('source.replace(coordinatorImport + "\\n"'), "compact formatter must be inserted after the coordinator import");
assert.ok(integrationPatch.includes("/_internal/leverup-diagnostics-once"), "one-time read-only diagnostics route must be included in the build patcher");
assert.ok(integrationPatch.includes("ciel:leverup:diagnostics:one-time-token"), "the diagnostics route must require and consume a one-time KV token");
assert.ok(integrationPatch.includes("approvalTransactionSubmitted: false"), "the diagnostic route must never submit approvals or orders");
assert.ok(integrationPatch.includes("symbols: [requestedSymbol]"), "one-time diagnostics must run only the requested market per Worker invocation");
assert.ok(integrationPatch.includes('const allowedSymbols = ["BTC","ETH","BNB","XRP","HYPE","ONDO","KPEPE","TRX","AAVE","ADA","DOGE","LINK","PUMP","SEI","SOL","SUI","UNI","VIRTUAL"];'), "one-time diagnostics must allow every configured 50x+ LeverUp market");
assert.ok(integrationPatch.includes("skipCoordinator: false"), "scheduled diagnostics must verify the temporary coordinator dry-run at the five-minute cadence");
assert.ok(integrationPatch.includes("5 * 60 * 1000"), "scheduled diagnostics must rotate one market every five minutes");

