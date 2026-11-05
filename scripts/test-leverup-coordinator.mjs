import assert from "node:assert/strict";
import { calculateLeverUpEntryBudget, evaluateLeverUpPortfolioRisk, LEVERUP_RISK_DEFAULTS, MIN_LEVERUP_RISK_LIMIT_MON } from "../src/leverup-risk.js";
assert.equal(MIN_LEVERUP_RISK_LIMIT_MON, 12);
assert.equal(LEVERUP_RISK_DEFAULTS.maxDailyRealizedLossMon, 12);
assert.equal(LEVERUP_RISK_DEFAULTS.maxRollingDrawdownMon, 12);
assert.equal(LEVERUP_RISK_DEFAULTS.maxAggregateStopRiskMon, 12);
import { prepareLeverUpExecution, reconcileLeverUpIntent, collectLeverUpPairBases } from "../src/leverup-coordinator.js";
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
console.log("PASS: collateral budget incl. fees/buffers, portfolio risk gates, hard-off dry-run coordinator, intent reconciliation primitives.");
