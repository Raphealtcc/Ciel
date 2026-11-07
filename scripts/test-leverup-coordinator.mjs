import assert from "node:assert/strict";
import { calculateLeverUpEntryBudget, evaluateLeverUpPortfolioRisk, LEVERUP_RISK_DEFAULTS, MIN_LEVERUP_RISK_LIMIT_MON } from "../src/leverup-risk.js";
assert.equal(MIN_LEVERUP_RISK_LIMIT_MON, 12);
assert.equal(LEVERUP_RISK_DEFAULTS.maxDailyRealizedLossMon, 12);
assert.equal(LEVERUP_RISK_DEFAULTS.maxRollingDrawdownMon, 12);
assert.equal(LEVERUP_RISK_DEFAULTS.maxAggregateStopRiskMon, 12);
import { prepareLeverUpExecution, reconcileLeverUpIntent, collectLeverUpPairBases, refreshLeverUpMarketOpenPlan, validateLeverUpTransferBalances, submitLeverUpNativeOnchainEntry } from "../src/leverup-coordinator.js";
import { privateKeyToAccount } from "viem/accounts";
const WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A";
const LVMON = "0x91b81bfbe3A747230F0529Aa28d8b2Bc898E6D56";
const LV = "0x1001ff13bf368aa4fa85f21043648079f00e1001";
const refreshed = refreshLeverUpMarketOpenPlan({
  plan: { actionValues: ["0x" + "11".repeat(20), true, WMON, LV, "10000000000000000000", "10000000000", "1010000000000000000", "990000000000000000", "1020000000000000000", 0, "0"],
    preflight: { notionalUsdRaw: "10000000000000000000", checkedAt: 1, oraclePriceRaw: "1000000000000000000", oraclePriceUsd: 1 } },
  pairView: { slippageConfig: { enabled: true, slippageLongP: 10, slippageShortP: 10, slippageType: 0 } },
  freshOraclePriceRaw: "1010000000000000000", now: 200,
});
assert.equal(refreshed.actionValues[5], 99009900990n);
assert.equal(refreshed.actionValues[6], 1013030000000000000n);
assert.equal(refreshed.protocolSlippageBps, "10");
assert.equal(refreshed.slippageBps, "30");
assert.equal(refreshed.preflight.checkedAt, 200);
const refreshedShort = refreshLeverUpMarketOpenPlan({
  plan: { actionValues: ["0x" + "11".repeat(20), false, WMON, LV, "10000000000000000000", "10000000000", "1010000000000000000", "0", "0", 0, "0"], preflight: { notionalUsdRaw: "10000000000000000000", checkedAt: 1, oraclePriceRaw: "1000000000000000000", oraclePriceUsd: 1 } },
  pairView: { slippageConfig: { enabled: true, slippageLongP: 10, slippageShortP: 10, slippageType: 0 } }, freshOraclePriceRaw: "1010000000000000000", now: 201,
});
assert.equal(refreshedShort.actionValues[6], 1006970000000000000n);
assert.equal(refreshedShort.slippageBps, "30");
assert.throws(() => refreshLeverUpMarketOpenPlan({ plan: { actionValues: ["0x" + "11".repeat(20), true, WMON, LV, "10000000000000000000", "10000000000", "1010000000000000000", "990000000000000000", "1020000000000000000", 0, "0"], preflight: { notionalUsdRaw: "10000000000000000000" } }, pairView: { slippageConfig: { enabled: true, slippageLongP: 10, slippageShortP: 10, slippageType: 1 } }, freshOraclePriceRaw: "1010000000000000000" }), /LIVE_SLIPPAGE_TYPE_UNSUPPORTED/);
assert.throws(() => refreshLeverUpMarketOpenPlan({ plan: { actionValues: ["0x" + "11".repeat(20), true, WMON, LV, "10000000000000000000", "10000000000", "1010000000000000000", "990000000000000000", "1020000000000000000", 0, "0"], preflight: { notionalUsdRaw: "10000000000000000000" } }, pairView: { slippageConfig: { enabled: true, slippageLongP: 10, slippageShortP: 10, slippageType: 0 } }, freshOraclePriceRaw: "1010000000000000000", entryPriceToleranceBps: 101 }), /LIVE_ENTRY_PRICE_TOLERANCE_INVALID/);
const wmonFeeCheck = validateLeverUpTransferBalances({
  action: 0,
  actionValues: ["0x" + "11".repeat(20), true, WMON, LV, "1000", "1", "1", "0", "0", 0, "50"],
  feeToken: WMON, antiDdosFee: 25n,
  tokenStates: {
    [WMON.toLowerCase()]: { balance: 1075n, allowance: 1074n },
    [LV.toLowerCase()]: { balance: 0n, allowance: 0n },
  },
});
assert.equal(wmonFeeCheck.ok, false, "WMON requirement must include amountIn, extraFee, and same-token anti-DDOS fee");
assert.equal(wmonFeeCheck.required[WMON.toLowerCase()].required, "1075");
const wmonFeePass = validateLeverUpTransferBalances({
  action: 0,
  actionValues: ["0x" + "11".repeat(20), true, WMON, LV, "1000", "1", "1", "0", "0", 0, "50"],
  feeToken: WMON, antiDdosFee: 25n,
  tokenStates: {
    [WMON.toLowerCase()]: { balance: 1075n, allowance: 1075n },
    [LVMON.toLowerCase()]: { balance: 0n, allowance: 0n },
  },
});
assert.equal(wmonFeePass.ok, true);
const b50 = calculateLeverUpEntryBudget({minimumCollateralUsd:.45,leverage:50,monUsdPrice:.02,openFeeUsd:.01,closeFeeUsd:.01});
const b100 = calculateLeverUpEntryBudget({minimumCollateralUsd:.23,leverage:100,monUsdPrice:.02});
assert.equal(b50.collateralUsd,.45); assert.equal(b100.collateralUsd,.23);
assert.ok(b50.requiredMon > 22.5); assert.ok(b100.requiredMon > 11.5);
assert.throws(()=>calculateLeverUpEntryBudget({minimumNotionalUsd:20,leverage:25,monUsdPrice:.02,collateralRatio:1}),/50X/);
const safe=evaluateLeverUpPortfolioRisk({requestedLeverage:100,availableWmonMon:25,requestedMarginMon:1,entryBudgetMon:1,currentOpenPositions:[],proposedStopRiskMon:.2,killSwitchActive:false});
const productionSized=evaluateLeverUpPortfolioRisk({requestedLeverage:100,totalAllocationMon:50,reserveMon:25,availableWmonMon:25,requestedMarginMon:13.2,entryBudgetMon:13.2,currentOpenPositions:[],proposedStopRiskMon:5.28,aggregateStopRiskMon:0,maxAggregateStopRiskMon:12,dailyRealizedLossMon:0,maxDailyRealizedLossMon:12,rollingDrawdownMon:0,maxRollingDrawdownMon:12,killSwitchActive:false});
assert.equal(productionSized.allowed,true,"100x minimum-size entry from the latest BTC preflight (13.198 MON margin, 0.4% stop) must pass the 6 MON risk envelope");
const feeBudgetOverrun=evaluateLeverUpPortfolioRisk({requestedLeverage:50,totalAllocationMon:50,reserveMon:25,availableWmonMon:125,requestedMarginMon:24.9,entryBudgetMon:25.1,currentOpenPositions:[],proposedStopRiskMon:0.5,aggregateStopRiskMon:0,maxAggregateStopRiskMon:12,dailyRealizedLossMon:0,maxDailyRealizedLossMon:12,rollingDrawdownMon:0,maxRollingDrawdownMon:12,killSwitchActive:false});
assert.equal(feeBudgetOverrun.allowed,false,"margin plus entry fees must not consume the 25 MON reserve");
assert.ok(feeBudgetOverrun.reasons.includes("TRADE_EXCEEDS_USABLE_ALLOCATION"));
const withinFeeBudget=evaluateLeverUpPortfolioRisk({requestedLeverage:50,totalAllocationMon:50,reserveMon:25,availableWmonMon:125,requestedMarginMon:23.5,entryBudgetMon:24.2,currentOpenPositions:[],proposedStopRiskMon:0.5,aggregateStopRiskMon:0,maxAggregateStopRiskMon:12,dailyRealizedLossMon:0,maxDailyRealizedLossMon:12,rollingDrawdownMon:0,maxRollingDrawdownMon:12,killSwitchActive:false});
assert.equal(withinFeeBudget.allowed,true,"minimum-size trade plus costs should pass when the full entry budget stays inside the 25 MON allocation");
assert.equal(evaluateLeverUpPortfolioRisk({requestedLeverage:1000,totalAllocationMon:50,reserveMon:25,availableWmonMon:25,requestedMarginMon:11,entryBudgetMon:11,currentOpenPositions:[],proposedStopRiskMon:44,aggregateStopRiskMon:0,maxAggregateStopRiskMon:12,dailyRealizedLossMon:0,maxDailyRealizedLossMon:12,rollingDrawdownMon:0,maxRollingDrawdownMon:12,killSwitchActive:false}).allowed,false,"1000x at 11 MON margin with a 0.4% stop risks 44 MON and must not be allowed against the 12 MON hard risk floor");
assert.equal(safe.allowed,true);
const floored = evaluateLeverUpPortfolioRisk({
  requestedLeverage:100, availableWmonMon:25, requestedMarginMon:1, entryBudgetMon:1,
  currentOpenPositions:[], proposedStopRiskMon:0.2, dailyRealizedLossMon:11.9,
  maxDailyRealizedLossMon:1, rollingDrawdownMon:11.9, maxRollingDrawdownMon:2,
  aggregateStopRiskMon:11.9, maxAggregateStopRiskMon:1, killSwitchActive:false,
});
assert.equal(floored.allowed,false, "configured risk caps below 12 MON must be floored to 12 MON, never used as tiny limits");
assert.deepEqual(floored.riskLimitsMon, {dailyLoss:12, drawdown:12, aggregateStopRisk:12});
assert.equal(evaluateLeverUpPortfolioRisk({
  requestedLeverage: 100, availableWmonMon: 25, requestedMarginMon: 1, entryBudgetMon: 1,
  currentOpenPositions: [], proposedStopRiskMon: 0.2, dailyRealizedLossMon: 11.9,
  maxDailyRealizedLossMon: 1, killSwitchActive: false,
}).allowed, false, "projected stop loss must fit inside the remaining daily loss budget");
assert.equal(evaluateLeverUpPortfolioRisk({
  requestedLeverage: 100, availableWmonMon: 25, requestedMarginMon: 1, entryBudgetMon: 1,
  currentOpenPositions: [], proposedStopRiskMon: 0.2, rollingDrawdownMon: 11.9,
  maxRollingDrawdownMon: 2, killSwitchActive: false,
}).allowed, false, "projected stop loss must fit inside the remaining drawdown budget");
for (const patch of [{requestedLeverage:25},{availableWmonMon:0},{requestedMarginMon:26},{currentOpenPositions:[{}]},{staleFeed:true},{executionUncertain:true},{dailyRealizedLossMon:12},{rollingDrawdownMon:12},{proposedStopRiskMon:12.01}]) {
 const r=evaluateLeverUpPortfolioRisk({requestedLeverage:100,availableWmonMon:25,requestedMarginMon:1,entryBudgetMon:1,currentOpenPositions:[],proposedStopRiskMon:.1,killSwitchActive:false,...patch});
 assert.equal(r.allowed,false);
}
let saved=null;
const plan=await prepareLeverUpExecution({signal:{id:"sig-1"},preflight:{status:"PREFLIGHT_PASS_LIVE_DISABLED",selectedLeverage:100,marginMonUsed:1},account:{wmonBalanceMon:25,openPositions:[]},portfolio:{},env:{LEVERUP_LIVE_TRADING:"false",LEVERUP_KILL_SWITCH:"true"},store:{put:async(k,v)=>saved=JSON.parse(v)}});
assert.equal(plan.status,"DRY_RUN_APPROVED"); assert.equal(plan.liveSubmissionPerformed,false); assert.equal(saved.signalId,"sig-1");
const bad=await prepareLeverUpExecution({signal:{id:"sig-2"},preflight:{status:"PREFLIGHT_PASS_LIVE_DISABLED",selectedLeverage:100,marginMonUsed:1},account:{wmonBalanceMon:25,openPositions:[]},portfolio:{},env:{LEVERUP_LIVE_TRADING:"true",LEVERUP_KILL_SWITCH:"true"}});
assert.equal(bad.reason,"UNSAFE_EXECUTION_CONFIGURATION");
let reads=0;
const rec=await reconcileLeverUpIntent({intentHash:"0x"+"ab".repeat(32),pollStatus:async()=>({executed:true}),readPositions:async()=>{reads++;return [{positionHash:"0x1"}]}});
assert.equal(rec.status,"RECONCILED"); assert.equal(reads,1);
await assert.rejects(()=>reconcileLeverUpIntent({intentHash:"bad",pollStatus:async()=>({}),readPositions:async()=>[]}),/INVALID_INTENT_HASH/);

const fallbackBases = collectLeverUpPairBases([], [{ pairBase: "0x" + "12".repeat(20) }]);
assert.deepEqual(fallbackBases, ["0x" + "12".repeat(20)], "on-chain pair discovery must retain the pair base from active D1 entries");
const combinedBases = collectLeverUpPairBases([{ pairBase: "0x" + "34".repeat(20) }], [{ pairBase: "0x" + "12".repeat(20) }]);
assert.deepEqual(combinedBases.sort(), ["0x" + "12".repeat(20), "0x" + "34".repeat(20)].sort());

function fakeIntentDb() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      let params = [];
      return {
        bind(...values) { params = values; return this; },
        async first() {
          if (sql.includes("WHERE signal_id = ?")) return rows.get(params[0]) || null;
          if (sql.includes("WHERE idempotency_key = ?")) return [...rows.values()].find((x) => x.idempotency_key === params[0]) || null;
          return null;
        },
        async run() {
          if (sql.startsWith("INSERT INTO leverup_execution_intents")) {
            rows.set(params[0], {
              signal_id: params[0], idempotency_key: params[1], status: "PREPARED",
              pair_base: params[2], action: params[3], requested_leverage: params[4],
              margin_mon: params[5], notional_usd: params[6], payload_json: params[7],
            });
            return { success: true };
          }
          if (sql.startsWith("UPDATE leverup_execution_intents")) {
            const signalId = params[params.length - 1];
            const row = rows.get(signalId);
            if (!row) return { success: false };
            const fields = sql.slice(sql.indexOf(" SET ") + 5, sql.indexOf(" WHERE ")).split(", ");
            fields.forEach((field, index) => {
              const key = field.split(" = ")[0];
              const value = params[index];
              if (key === "intent_hash") row.intent_hash = value;
              else if (key === "last_error") row.last_error = value;
              else if (key === "payload_json") row.payload_json = value;
              else if (key === "status") row.status = value;
            });
            return { success: true };
          }
          return { success: true };
        },
      };
    },
  };
}
const testKey = "0x" + "0".repeat(63) + "1";
const testTrader = privateKeyToAccount(testKey).address;
const zero = "0x0000000000000000000000000000000000000000";
const nativePlan = {
  selectedLeverage: 50, marginMonUsed: "1", notionalUsd: 20,
  actionValues: ["0x" + "11".repeat(20), true, zero, LVMON, "1000000000000000000",
    "10000000000", "1000000000000000000", "0", "0", 0, "0"],
};
const nativeOracle = { updateData: { pythPriceUpdateData: [], pythProPriceUpdateData: [] }, value: 1n };
const liveNativeEnv = { LEVERUP_LIVE_TRADING: "true", LEVERUP_KILL_SWITCH: "false", LEVERUP_TRADER_PRIVATE_KEY: testKey };
const failedSimulationDb = fakeIntentDb();
let failedSimulationWrites = 0;
const failedSimulation = await submitLeverUpNativeOnchainEntry({
  env: liveNativeEnv, db: failedSimulationDb, signalId: "NATIVE-SIM-FAIL",
  candidate: { symbol: "BTC", side: "LONG" }, plan: nativePlan, traderAddress: testTrader,
  pairBase: nativePlan.actionValues[0], oracleUpdate: nativeOracle, now: 10,
  dependencies: {
    publicClient: {
      simulateContract: async () => { throw new Error("insufficient transfers"); },
      getBalance: async () => 10n ** 20n,
    },
    walletClient: { writeContract: async () => { failedSimulationWrites++; return "0x" + "ab".repeat(32); } },
    getBalance: async () => 10n ** 20n,
  },
});
assert.equal(failedSimulation.status, "REJECTED");
assert.equal(failedSimulation.submitted, false);
assert.equal(failedSimulationWrites, 0, "a failed exact contract simulation must never broadcast");
assert.equal(failedSimulationDb.rows.get("NATIVE-SIM-FAIL").status, "REJECTED");
const submittedDb = fakeIntentDb();
const txHash = "0x" + "cd".repeat(32);
const submitted = await submitLeverUpNativeOnchainEntry({
  env: liveNativeEnv, db: submittedDb, signalId: "NATIVE-SUBMITTED",
  candidate: { symbol: "BTC", side: "LONG" }, plan: nativePlan, traderAddress: testTrader,
  pairBase: nativePlan.actionValues[0], oracleUpdate: nativeOracle, now: 11,
  dependencies: {
    publicClient: {
      simulateContract: async () => ({ request: { simulated: true } }),
      waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 123n }),
      getBalance: async () => 10n ** 20n,
    },
    walletClient: { writeContract: async () => txHash },
    getBalance: async () => 10n ** 20n,
    readPositions: async () => [],
  },
});
assert.equal(submitted.status, "SUBMITTED", "a mined pending-trade transaction must not be mislabeled as a filled position");
assert.equal(submitted.submitted, true);
assert.equal(submitted.transactionHash, txHash);
assert.equal(submittedDb.rows.get("NATIVE-SUBMITTED").status, "SUBMITTED");
assert.equal(submittedDb.rows.get("NATIVE-SUBMITTED").intent_hash, txHash);


const hostedDb = fakeIntentDb();
const hostedTrader = testTrader;
const hostedAgentKey = "0x" + "0".repeat(63) + "2";
const hostedAgent = privateKeyToAccount(hostedAgentKey).address;
const hostedPair = "0x" + "44".repeat(20);
const hostedWmon = WMON.toLowerCase();
const hostedLv = LV.toLowerCase();
let hostedSubmitArgs = null, hostedApprovalCount = 0;
const hostedNow = Date.now();
const hostedEntry = await (await import("../src/leverup-coordinator.js")).executeLeverUpEntry({
  env: {
    LEVERUP_LIVE_TRADING: "true", LEVERUP_KILL_SWITCH: "false",
    DB: { prepare: () => ({ bind: (key) => ({ first: async () => ({ control_value: "true" }) }) }) },
    LEVERUP_AGENT_ADDRESS: hostedAgent, LEVERUP_TRADER_ADDRESS: hostedTrader,
    LEVERUP_AGENT_PRIVATE_KEY: hostedAgentKey, LEVERUP_AUTO_APPROVE: "true",
    LEVERUP_TOTAL_ALLOCATION_MON: "50", LEVERUP_RESERVE_MON: "25",
  },
  db: hostedDb, signalId: "HOSTED-AGENT-ENTRY",
  candidate: { symbol: "BTC", side: "LONG", stopPct: 0.4 },
  now: hostedNow,
  snapshot: {
    traderAddress: hostedTrader, agentAddress: hostedAgent, checkedAt: hostedNow,
    market: { base: hostedPair },
    pairView: { slippageConfig: { enabled: true, slippageLongP: 5, slippageShortP: 5, slippageType: 0 } },
    indexedPositions: [],
    agentAuthorization: { authorized: true, agentAddress: hostedAgent, canMarketOpen: true },
    accountTokenStates: { [hostedWmon]: { balance: (100n * 10n ** 18n).toString(), allowance: "0" } },
  },
  plan: {
    actionValues: [hostedPair, true, hostedWmon, hostedLv, (101n * 10n ** 16n).toString(),
      "2000000000", (100n * 10n ** 18n).toString(), (99n * 10n ** 18n).toString(),
      (102n * 10n ** 18n).toString(), 0, "0"],
    feeToken: "0x0000000000000000000000000000000000000000", antiDdosFee: "0",
    nonce: "1", selectedLeverage: 50, marginMonUsed: "1", notionalUsd: 20,
    totalAllocationMon: 50, reserveMon: 25,
    preflight: { preflightPassed: true, status: "AVAILABLE", pairBase: hostedPair,
      requestedLeverage: 50, marketMaxLeverage: 50, maxLeverageForNotional: 50,
      checkedAt: hostedNow, notionalUsdRaw: (20n * 10n ** 18n).toString() },
  },
  dependencies: {
    fetchLatestOraclePrices: async () => ({ [hostedPair.toLowerCase()]: (100n * 10n ** 18n).toString() }),
    readNonce: async () => 77n,
    readPortfolioRisk: async () => ({ aggregateStopRiskMon: 0, dailyRealizedLossMon: 0, rollingDrawdownMon: 0 }),
    ensureAllowance: async () => { hostedApprovalCount++; return { status: "APPROVED" }; },
    readTokenBalancesAndAllowances: async () => ({
      [hostedWmon]: { balance: 100n * 10n ** 18n, allowance: 100n * 10n ** 18n },
    }),
    submit: async (args) => {
      hostedSubmitArgs = args;
      return { intentHash: "0x" + "ef".repeat(32), intent: { actionDataHash: "0x" + "cd".repeat(32) } };
    },
  },
});
assert.equal(hostedEntry.status, "SUBMITTED");
assert.equal(hostedEntry.executionPath, "1CT_HOSTED_AGENT");
assert.equal(hostedSubmitArgs.action, 0);
assert.equal(hostedSubmitArgs.actionValues[2].toLowerCase(), hostedWmon);
assert.equal(hostedSubmitArgs.actionValues[3].toLowerCase(), hostedLv);
assert.ok(BigInt(hostedSubmitArgs.nonce) > 77n, "hosted-agent entry must use a nonce above the latest on-chain nonce");
assert.equal(hostedApprovalCount, 1);
assert.equal(hostedDb.rows.get("HOSTED-AGENT-ENTRY").status, "SUBMITTED");
assert.equal(JSON.parse(hostedDb.rows.get("HOSTED-AGENT-ENTRY").payload_json).executionPath, "1CT_HOSTED_AGENT");

console.log("PASS: collateral budget incl. fees/buffers, portfolio risk gates, hard-off dry-run coordinator, intent reconciliation primitives.");
