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
  LEVERUP_COLLATERAL_50X_USD: "0.43", LEVERUP_COLLATERAL_100X_USD: "0.23", LEVERUP_MAX_TRADE_MARGIN_MON: "25",
  LEVERUP_TRADER_ADDRESS: trader, LEVERUP_AGENT_ADDRESS: agent,
  CIEL_STATE: { put: async () => {} }, DB: { prepare: () => ({}) },
};
const candidate = { symbol: "BTC", side: "LONG", stopPct: 0.4, targetPct: 0.64, holdMinutes: 180, mode: "TREND_HOLD" };
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
const collateral50 = (await import("../src/leverup-advisor.js")).leverUpCollateralUsdForLeverage;
assert.equal(collateral50({ leverage: 50, minimumNotionalUsd: 20 }), 0.43);
assert.equal(collateral50({ leverage: 75, minimumNotionalUsd: 20 }), 0.33);
assert.equal(collateral50({ leverage: 100, minimumNotionalUsd: 20 }), 0.23);
assert.equal(collateral50({ leverage: 150, minimumNotionalUsd: 20 }), 0.23);
assert.equal(collateral50({ leverage: 75, minimumNotionalUsd: 40 }), 0.66);
assert.throws(() => collateral50({ leverage: 25, minimumNotionalUsd: 20 }), /SCHEDULE_INPUT_INVALID/);

const ready = await prepareLeverUpAdvisorPlan({
  env: { ...env }, candidate, reviewed,
  signalId: "SIG-READY", now: 1_800_000_000_000, dependencies,
});
assert.equal(ready.status, "PREFLIGHT_PASS_LIVE_DISABLED");
assert.equal(ready.liveExecutionEnabled, false);
assert.equal(ready.killSwitchEnabled, true);
assert.equal(ready.selectedLeverage, 100);
assert.ok(Math.abs(seenPlanArgs.snapshot.collateralRatio - (20 / (100 * 0.23))) < 1e-9,
  "100x collateral ratio must be derived from the $0.23 minimum, not a hardcoded protocol ratio");
assert.ok(Math.abs(ready.minimumMarginMon - (0.23 / 0.019038)) < 1e-6,
  "minimum WMON must be calculated from the $0.23 USD collateral and live MON/USD oracle");
const expectedLiveMarginMon = Math.max(12, ready.minimumMarginMon);
assert.equal(seenPlanArgs.desiredMarginMon, Math.ceil(ready.minimumMarginMon * 1e8) / 1e8,
  "minimum margin passed to the plan must round upward to avoid floating-point underfunding");
assert.ok(Math.abs(seenPlanArgs.desiredMarginMon - expectedLiveMarginMon) < 1e-9,
  "LeverUp must use its independent live margin proposal, clamped only to the venue minimum collateral");
assert.ok(seenPlanArgs.desiredMarginMon > reviewed.paperMarginMon,
  "LeverUp sizing must not inherit the smaller paper margin");
assert.equal(seenPlanArgs.maxTradeMarginMon, 25, "live margin ceiling must use the configured LeverUp cap");
assert.equal(seenPlanArgs.reserveMon, 25);
assert.ok(seenPlanArgs.stopLossPriceRaw > 0n && seenPlanArgs.takeProfitPriceRaw > 0n);
assert.equal(seenPersist.options.decision, "PASS");
assert.equal(ready.ledgerPersisted, true);
assert.ok(formatLeverUpAdvisorLine(ready).includes("DRY RUN ONLY"));
assert.ok(formatLeverUpAdvisorLine(ready).includes("PORTFOLIO RISK BLOCKED"),
  "the $1 MON stop-risk cap must be reported when the 0.4% stop implies higher risk");

const below50 = await prepareLeverUpAdvisorPlan({
  env: { ...env }, candidate: { ...candidate, leverage: 25 },
  reviewed, signalId: "SIG-25", now: 1_800_000_000_000, dependencies,
});
assert.equal(below50.status, "BLOCKED_PREFLIGHT");
assert.match(below50.reason, /BELOW_50X/);

const existing = await prepareLeverUpAdvisorPlan({
  env: { ...env }, candidate, reviewed,
  signalId: "SIG-OPEN", now: 1_800_000_000_000,
  dependencies: { readSnapshot: async ({ collateralRatio }) => ({ ...baseSnapshot(collateralRatio), indexedPositions: [{ positionHash: "0xabc" }] }) },
});
assert.equal(existing.status, "BLOCKED_EXISTING_POSITION");

const notApproved = await prepareLeverUpAdvisorPlan({
  env: { ...env }, candidate, reviewed: { verdict: "WAIT" },
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

console.log("PASS: CIEL-to-LeverUp preflight is read-only, 50x-minimum, reserve-aware, approval-gated, existing-position-safe, ledger-backed, and hard-locked from live execution, with read-only wallet and synthetic signer diagnostics.");

const integrationPatch = await readFile(new URL("./apply-leverup-integration.mjs", import.meta.url), "utf8");
assert.ok(integrationPatch.includes("/_internal/leverup-diagnostics-once"), "one-time read-only diagnostics route must be included in the build patcher");
assert.ok(integrationPatch.includes("ciel:leverup:diagnostics:one-time-token"), "the diagnostics route must require and consume a one-time KV token");
assert.ok(integrationPatch.includes("approvalTransactionSubmitted: false"), "the diagnostic route must never submit approvals or orders");
assert.ok(integrationPatch.includes("symbols: [requestedSymbol]"), "one-time diagnostics must run only the requested market per Worker invocation");
assert.ok(integrationPatch.includes("skipCoordinator: true"), "scheduled diagnostics must not spend recurring D1 reads on the temporary coordinator test");
assert.ok(integrationPatch.includes("5 * 60 * 1000"), "scheduled diagnostics must rotate one market every five minutes");

