import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const source=await readFile("reconstructed/patched-worker.js","utf8");
const helperStart=source.indexOf("function buildAdaptiveLearningProfile");
const advisorStart=source.indexOf("async function runAdvisorCycle",helperStart);
assert.ok(helperStart>=0&&advisorStart>helperStart);
const context=vm.createContext({
  __name(){},
  anchoredReturn(points,minutes){
    const last=points[points.length-1],target=last.t-minutes*60000;
    let base=null;
    for(let i=points.length-2;i>=0;i--)if(points[i].t<=target){base=points[i];break;}
    return base&&base.p>0?(last.p/base.p-1)*100:null;
  },
  emaTimed(points,period){
    if(points.length<period)return NaN;
    const k=2/(period+1);let value=points[0].p;
    for(let i=1;i<points.length;i++)value=points[i].p*k+value*(1-k);
    return value;
  },
  classifyMarketRegime(points,r5,r15,r60,e20,e50){
    const recent=points.filter(p=>p.t>=points[points.length-1].t-30*60000).slice(-40);
    let path=0;for(let i=1;i<recent.length;i++)path+=Math.abs((recent[i].p/recent[i-1].p-1)*100);
    const efficiency=path>0?Math.abs((recent[recent.length-1].p/recent[0].p-1)*100)/path:0;
    return {efficiency,emaGapPct:e50>0?Math.abs(e20/e50-1)*100:0};
  }
});
vm.runInContext(source.slice(helperStart,advisorStart)+"\nglobalThis.learningTests={buildAdaptiveLearningProfile,adaptiveCandidateMultiplier,analyzeCoreTrendContinuation,analyzeMicroMomentumContinuation};",context);
const {buildAdaptiveLearningProfile,adaptiveCandidateMultiplier,analyzeCoreTrendContinuation,analyzeMicroMomentumContinuation}=context.learningTests;
const now=1800000000000;
const trade=(i,pnl,mode="CORE_PULLBACK_SCALP",symbol="BTC")=>({status:"CLOSED",closedAtMs:now-i*60000,signalId:"s"+i,symbol,mode,grossPnlMon:pnl,marginMon:10,bestFavorableMovePct:Math.max(0,pnl),closeReason:pnl>0?"TAKE_PROFIT":"STOP_LOSS"});
const insufficient=buildAdaptiveLearningProfile(Array.from({length:7},(_,i)=>trade(i,1)),now);
assert.equal(adaptiveCandidateMultiplier(insufficient,{symbol:"BTC",mode:"CORE_PULLBACK_SCALP"}),1);
const profitable=buildAdaptiveLearningProfile(Array.from({length:20},(_,i)=>trade(i,1)),now);
const good=adaptiveCandidateMultiplier(profitable,{symbol:"BTC",mode:"CORE_PULLBACK_SCALP"});
assert.ok(good>1&&good<=1.1);
const losing=buildAdaptiveLearningProfile(Array.from({length:20},(_,i)=>trade(i,-1)),now);
const bad=adaptiveCandidateMultiplier(losing,{symbol:"BTC",mode:"CORE_PULLBACK_SCALP"});
assert.ok(bad<1&&bad>=0.9);
assert.equal(adaptiveCandidateMultiplier(profitable,{symbol:"BTC",mode:"TREND_HOLD"}),1);
assert.ok(source.includes('["BTC","ETH","SOL", ...configuredWatchSymbols(env.WATCH_SYMBOLS)]'));
assert.ok(source.includes("orderedSymbols"));
assert.ok(!source.includes("signal.confidence >= minimumConfidence"));
assert.ok(!source.includes("scalp.confidence >= minimumConfidence"));
assert.ok(!source.includes("continuation.confidence >= minimumConfidence"));
assert.ok(source.includes("Math.max(0.03, candidate.stopPct * 0.10)"));
assert.ok(source.includes("stronglyOpposed"));
assert.ok(source.includes('candidate.mode !== "CORE_PULLBACK_SCALP"'));
assert.ok(source.includes("candidate.rsi < 10") && source.includes("candidate.rsi > 90"));
assert.ok(source.includes('const preferredGroup = Math.floor(now / (5 * 60e3)) % 3 === 2 ? "WATCHLIST" : "CORE"'));
assert.ok(source.includes('signal.mode === "TREND_HOLD" || signal.mode === "RANGE_SCALP"'));
assert.ok(source.includes("1M_SWING_REVERSAL+RECLAIM"));
assert.ok(source.includes("var CYCLE = 6e4;"));
assert.ok(source.includes("coreMarkets:[\"BTC\",\"ETH\",\"SOL\"],preferredGroup"));
assert.ok(source.includes("scanDiagnostics:scanDiagnostics.slice(-120)"));
assert.ok(source.includes('"INSUFFICIENT_CLOSED_CANDLE_HISTORY"'));

function trendCandles(direction) {
  const rows=[];
  for(let i=0;i<45;i++){
    // Alternating swing highs/lows create a genuine, steadily rising/falling structure.
    const base=100+direction*i*0.025+direction*0.10*Math.sin(i*Math.PI/2);
    rows.push({
      open_ts_ms:now-(45-i)*300e3,
      close_ts_ms:now-(44-i)*300e3-60e3,
      open_price:base-direction*0.015,
      high_price:base+0.02,
      low_price:base-0.02,
      close_price:base+direction*0.015,
      volume:100
    });
  }
  const range=rows.slice(20,40);
  const level=direction>0?Math.max(...range.map(c=>c.high_price)):Math.min(...range.map(c=>c.low_price));
  if(direction>0){
    rows[43]={...rows[43],open_price:level+0.02,high_price:level+0.07,low_price:level+0.01,close_price:level+0.055,volume:200};
    rows[44]={...rows[44],open_price:level+0.065,high_price:level+0.11,low_price:level-0.005,close_price:level+0.095,volume:120};
  } else {
    rows[43]={...rows[43],open_price:level-0.02,high_price:level-0.01,low_price:level-0.07,close_price:level-0.055,volume:200};
    rows[44]={...rows[44],open_price:level-0.065,high_price:level+0.005,low_price:level-0.11,close_price:level-0.095,volume:120};
  }
  return rows;
}
const continuationLong=analyzeCoreTrendContinuation("BTC",trendCandles(1),now);
const continuationShort=analyzeCoreTrendContinuation("ETH",trendCandles(-1),now);
assert.equal(continuationLong?.side,"LONG");
assert.equal(continuationShort?.side,"SHORT");
assert.equal(continuationLong?.mode,"CORE_TREND_CONTINUATION");
assert.ok(continuationLong.stopPct<=0.45&&continuationShort.stopPct<=0.45);
assert.equal(analyzeCoreTrendContinuation("BTC",trendCandles(1).slice(0,20),now),null);
function microRows(direction){
  const rows=[];
  for(let i=0;i<80;i++){
    const base=100+direction*0.002*i;
    const first=i>=65?(i-64)*0.01:0;
    const second=i>=70?(i-69)*0.02:0;
    const third=i>=75?(i-74)*0.03:0;
    const price=base+direction*(first+second+third);
    rows.push({ts_ms:now-(80-i)*60000,mid_price:price});
  }
  return rows;
}
const microLong=analyzeMicroMomentumContinuation("BTC",microRows(1),now);
const microShort=analyzeMicroMomentumContinuation("ETH",microRows(-1),now);
assert.equal(microLong?.side,"LONG");
assert.equal(microShort?.side,"SHORT");
assert.equal(analyzeMicroMomentumContinuation("BNB",microRows(1),now),null,"1m micro-momentum is reserved for the three core markets with full 1m/60m context");
assert.equal(microLong?.mode,"TREND_HOLD");
assert.ok(microLong.stopPct<=0.45&&microShort.stopPct<=0.45);
assert.equal(analyzeMicroMomentumContinuation("BTC",microRows(1).slice(0,8),now),null);

assert.ok(source.includes("cooldown.allKeysFailed === true"));
assert.ok(source.includes("for (let i = 0; i < keys.length; i++)"));
assert.ok(source.includes("keyIndexUsed: ix + 1"));
assert.ok(source.includes("ALL_KEYS_RATE_LIMITED"));
assert.ok(!source.includes("stopped key rotation because quota may be project-wide"));
assert.ok(source.includes("function analyzeCoreTrendContinuation"));
assert.ok(source.includes("function analyzeMicroMomentumContinuation"));
assert.ok(source.includes("NO_CONFIRMED_3M_5M_10M_RANGE_BREAKOUT"));
assert.ok(source.includes("1M_MICRO_MOMENTUM_BREAKOUT"));
assert.ok(source.includes("CORE_TREND_CONTINUATION"));
assert.ok(source.includes("5M_STRUCTURE+EMA+MACD+RSI+BREAKOUT_RETEST"));
assert.ok(source.includes("corePullbackScalp: modeStats(\"CORE_PULLBACK_SCALP\")"));
assert.ok(source.includes("coreTrendContinuation: modeStats(\"CORE_TREND_CONTINUATION\")"));
assert.ok(source.includes('"PULLBACK_RECLAIM_VOLUME_OR_FRESHNESS_GATE"'));
assert.ok(source.includes("coreForecastChecks>=Math.min(3,coreTrendCandidateCount)")&&source.includes("otherForecastChecks>=6-Math.min(3,coreTrendCandidateCount)"));
assert.ok(source.includes('paperStorage.put("ciel:adaptive-learning:v1"'));
assert.ok(source.includes("advisorScanRaw"));
assert.ok(source.includes("advisorScan") && source.includes("feed:"), "protected diagnostics must include advisor scan data and feed status");
assert.ok(source.includes("Core pullback scalps: "));
assert.ok(source.includes("5m trend continuation: "));
const helperScopeStart=source.indexOf('__name(analyse, "analyse");');
const helperScopeEnd=source.indexOf("async function review(",helperScopeStart);
assert.ok(helperScopeStart>=0&&helperScopeEnd>helperScopeStart);
const topLevelHelpers=source.slice(helperScopeStart,helperScopeEnd);
assert.ok(topLevelHelpers.includes("async function getCandleStructureMap("),"candle structure map helper must be top-level and visible to runAdvisorCycle");
assert.ok(topLevelHelpers.includes("function analyzeCandleLevelReversal("),"candle-level reversal helper must be top-level and visible to runAdvisorCycle");
assert.ok(topLevelHelpers.includes("async function getCandleStructureEvidence("),"candle evidence helper must be top-level and visible to runAdvisorCycle");
assert.ok(source.includes("CIEL deterministic core trend continuation guard"));
assert.ok(source.includes("LOCAL_CORE_TREND_CONTINUATION"));

assert.ok(!source.includes('paperStorage.put("ciel:adaptive-learning:v1").bind'));

console.log("PASS: bounded adaptive learning, core-market scheduling, separate /profits strategy buckets, and 5m breakout-retest long/short gates.");
