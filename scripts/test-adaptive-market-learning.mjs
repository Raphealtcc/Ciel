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
vm.runInContext(source.slice(helperStart,advisorStart)+"\nglobalThis.learningTests={buildAdaptiveLearningProfile,adaptiveCandidateMultiplier,adaptiveStrategyPriority,analyzeCoreTrendContinuation};",context);
const {buildAdaptiveLearningProfile,adaptiveCandidateMultiplier,adaptiveStrategyPriority,analyzeCoreTrendContinuation}=context.learningTests;
const now=1800000000000;
const trade=(i,pnl,mode="TREND_HOLD",symbol="BTC",strategy=mode,side="LONG",regime="TREND_UP")=>({status:"CLOSED",closedAtMs:now-i*60000,signalId:"s"+i,symbol,mode,strategy,side,regime,netPnlMon:pnl,marginMon:10,bestFavorableMovePct:Math.max(0,pnl),closeReason:pnl>0?"TAKE_PROFIT":"STOP_LOSS"});
const weakRecent=buildAdaptiveLearningProfile(Array.from({length:24},(_,i)=>trade(i,-2,"TREND_HOLD","BTC","MULTI_MARKET_LEVEL_SWEEP_RECLAIM","SHORT","LEVEL_REVERSAL")),now);
assert.ok(weakRecent.byStrategy.MULTI_MARKET_LEVEL_SWEEP_RECLAIM && weakRecent.bySide.SHORT && weakRecent.byRegime.LEVEL_REVERSAL);
const weakFactor=adaptiveCandidateMultiplier(weakRecent,{symbol:"BTC",mode:"TREND_HOLD",strategy:"MULTI_MARKET_LEVEL_SWEEP_RECLAIM",side:"SHORT",regime:"LEVEL_REVERSAL"});
assert.ok(weakFactor<0.9 && weakFactor>=0.70);
const strongRecent=buildAdaptiveLearningProfile(Array.from({length:24},(_,i)=>trade(i,2,"TREND_HOLD","PUMP","TREND+MOMENTUM+BREAKOUT","LONG","TREND_UP")),now);
const strongFactor=adaptiveCandidateMultiplier(strongRecent,{symbol:"PUMP",mode:"TREND_HOLD",strategy:"TREND+MOMENTUM+BREAKOUT",side:"LONG",regime:"TREND_UP"});
assert.ok(strongFactor>1.05 && strongFactor<=1.30);
const marketOnlyPenalty = adaptiveCandidateMultiplier({
  bySymbol: { SOL: { trades: 24, multiplier: 0.72 } },
  bySymbolStrategy: {}, byStrategy: {}, byMode: {}, bySide: {}, byRegime: {},
}, { symbol: "SOL", mode: "TREND_HOLD", strategy: "5M_TREND+1M_PULLBACK+RECLAIM", side: "LONG", regime: "TREND_UP" });
assert.ok(marketOnlyPenalty < 0.8, "net market-level losses must lower ranking without blocking the market");
const insufficient=buildAdaptiveLearningProfile(Array.from({length:7},(_,i)=>trade(i,1)),now);
assert.equal(adaptiveCandidateMultiplier(insufficient,{symbol:"BTC",mode:"TREND_HOLD"}),1);
const profitable=buildAdaptiveLearningProfile(Array.from({length:20},(_,i)=>trade(i,1)),now);
const good=adaptiveCandidateMultiplier(profitable,{symbol:"BTC",mode:"TREND_HOLD"});
assert.ok(good>1&&good<=1.30);
const losing=buildAdaptiveLearningProfile(Array.from({length:20},(_,i)=>trade(i,-1)),now);
const bad=adaptiveCandidateMultiplier(losing,{symbol:"BTC",mode:"TREND_HOLD"});
assert.ok(bad<1&&bad>=0.70);
assert.ok(adaptiveStrategyPriority({strategy:"5M_TREND_CONTINUATION+BREAKOUT_RETEST"})>adaptiveStrategyPriority({strategy:"5M_TREND+1M_PULLBACK+RECLAIM"}));
assert.ok(adaptiveStrategyPriority({strategy:"5M_TREND+1M_PULLBACK+RECLAIM"})>adaptiveStrategyPriority({strategy:"MULTI_MARKET_LEVEL_SWEEP_RECLAIM"}));
assert.ok(adaptiveStrategyPriority({strategy:"MULTI_MARKET_LEVEL_SWEEP_RECLAIM"})>adaptiveStrategyPriority({strategy:"1M_MICRO_MOMENTUM_BREAKOUT"}));
assert.ok(source.includes("candidate.strategyPriority=adaptiveStrategyPriority(candidate)"),"strategy performance preference must affect ranking only");
assert.ok(source.includes("candidate.feeAdjustedRewardRisk"),"candidate ranking must account for net reward/risk after round-trip fees");
assert.ok(source.includes("const netRewardPct=targetPct-0.06,netRiskPct=stopPct+0.06"),"ranking must account for 3 bps entry and exit fees");
assert.ok(source.includes('"BTC","ETH","SOL","BNB","HYPE","XRP","ONDO","KPEPE","TRX","AAVE","ADA","DOGE","LINK","PUMP","SEI","SUI","UNI","VIRTUAL", ...configuredWatchSymbols(env.WATCH_SYMBOLS)]'));
assert.ok(source.includes("orderedSymbols"));
assert.ok(source.includes('const trendEntryMarketSet = new Set(["BTC","ETH","SOL","BNB","HYPE","XRP","ONDO","KPEPE","TRX","AAVE","ADA","DOGE","LINK","PUMP","SEI","SUI","UNI","VIRTUAL"])'));
assert.ok(!source.includes("signal.confidence >= minimumConfidence"));
assert.ok(!source.includes("scalp.confidence >= minimumConfidence"));
assert.ok(!source.includes("continuation.confidence >= minimumConfidence"));
assert.ok(source.includes("Math.max(0.03, candidate.stopPct * 0.10)"));
assert.ok(source.includes("stronglyOpposed"));
assert.ok(source.includes('candidate.mode === "TREND_HOLD"'));
assert.ok(source.includes("candidate.rsi < 10") && source.includes("candidate.rsi > 90"));
assert.ok(source.includes('const preferredGroup = Math.floor(now / (5 * 60e3)) % 3 === 2 ? "WATCHLIST" : "CORE"'));
assert.ok(source.includes('signal.mode === "TREND_HOLD"'));
assert.ok(source.includes("1M_SWING_REVERSAL+RECLAIM"));
assert.ok(source.includes("var CYCLE = 6e4;"));
assert.ok(source.includes("scanSnapshot"));
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
assert.equal(continuationLong?.mode,"TREND_HOLD");
assert.ok(continuationLong.stopPct<=0.45&&continuationShort.stopPct<=0.45);
assert.equal(analyzeCoreTrendContinuation("BTC",trendCandles(1).slice(0,20),now),null);
assert.ok(source.includes("cooldown.allKeysFailed === true"));
assert.ok(source.includes("for (let i = 0; i < keys.length; i++)"));
assert.ok(source.includes("keyIndexUsed: ix + 1"));
assert.ok(source.includes("ALL_KEYS_RATE_LIMITED"));
assert.ok(!source.includes("stopped key rotation because quota may be project-wide"));
assert.ok(source.includes("function analyzeCoreTrendContinuation"));



assert.ok(source.includes("5M_TREND_CONTINUATION+BREAKOUT_RETEST"));
assert.ok(source.includes("5M_STRUCTURE+EMA+MACD+RSI+BREAKOUT_RETEST"));
assert.ok(source.includes('const strategyStats = { trendHold: modeStats("TREND_HOLD") }'));
assert.ok(!source.includes("strategyStats.rangeScalp") && !source.includes("strategyStats.corePullbackScalp") && !source.includes("strategyStats.coreTrendContinuation"));
assert.ok(source.includes('"PULLBACK_RECLAIM_VOLUME_OR_FRESHNESS_GATE"'));
assert.ok(source.includes("coreForecastChecks>=Math.min(3,coreTrendCandidateCount)")&&source.includes("otherForecastChecks>=6-Math.min(3,coreTrendCandidateCount)"));
assert.ok(source.includes('paperStorage.put("ciel:adaptive-learning:v2"'));
assert.ok(source.includes("advisorScanRaw"));
assert.ok(source.includes("advisorScan") && source.includes("feed:"), "protected diagnostics must include advisor scan data and feed status");
assert.ok(!source.includes("Core pullback scalps: "));
assert.ok(!source.includes("5m trend continuation: "));
const helperScopeStart=source.indexOf('__name(analyse, "analyse");');
const helperScopeEnd=source.indexOf("async function review(",helperScopeStart);
assert.ok(helperScopeStart>=0&&helperScopeEnd>helperScopeStart);
const topLevelHelpers=source.slice(helperScopeStart,helperScopeEnd);
assert.ok(topLevelHelpers.includes("function getCandleStructureMap("),"candle structure map helper must be top-level and visible to runAdvisorCycle");
assert.ok(topLevelHelpers.includes("function analyzeCandleLevelReversal("),"candle-level reversal helper must be top-level and visible to runAdvisorCycle");
assert.ok(topLevelHelpers.includes("function getCandleStructureEvidence("),"candle evidence helper must be top-level and visible to runAdvisorCycle");
assert.ok(source.includes("CIEL deterministic trend continuation guard"));
assert.ok(source.includes("LOCAL_TREND_BREAKOUT_RETEST"));

assert.ok(!source.includes('paperStorage.put("ciel:adaptive-learning:v2").bind'));

assert.ok(source.includes("candidate.strategy") && source.includes("profile?.bySymbol?.[symbol]") && source.includes("profile?.bySide?.[side]") && source.includes("profile?.byRegime?.[regime]"));
console.log("PASS: recent strategy/side/regime learning adjusts ranking only; all 18 eligible markets remain available.");

assert.ok(source.includes("const baseSignals = [analyzeCandleLevelReversal"), "both base signal generators must be evaluated independently");
