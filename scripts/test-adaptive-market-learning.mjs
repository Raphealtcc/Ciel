import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const source=await readFile("reconstructed/patched-worker.js","utf8");
const helperStart=source.indexOf("function buildAdaptiveLearningProfile");
const advisorStart=source.indexOf("async function runAdvisorCycle",helperStart);
assert.ok(helperStart>=0&&advisorStart>helperStart);
const context=vm.createContext({__name(){}});
vm.runInContext(source.slice(helperStart,advisorStart)+"\nglobalThis.learningTests={buildAdaptiveLearningProfile,adaptiveCandidateMultiplier,analyzeCoreTrendContinuation};",context);
const {buildAdaptiveLearningProfile,adaptiveCandidateMultiplier,analyzeCoreTrendContinuation}=context.learningTests;
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
assert.ok(source.includes('const preferredGroup = Math.floor(now / CYCLE) % 3 === 2 ? "WATCHLIST" : "CORE"'));
assert.ok(source.includes("coreMarkets:[\"BTC\",\"ETH\",\"SOL\"],preferredGroup"));
assert.ok(source.includes("scanDiagnostics:scanDiagnostics.slice(-120)"));
assert.ok(source.includes('"INSUFFICIENT_CLOSED_CANDLE_HISTORY"'));

function trendCandles(direction) {
  const rows=[];
  for(let i=0;i<45;i++){
    const base=100+direction*i*0.025;
    rows.push({open_ts_ms:now-(45-i)*300e3,close_ts_ms:now-(44-i)*300e3-60e3,open_price:base,high_price:base+0.03,low_price:base-0.03,close_price:base+direction*0.005,volume:100});
  }
  if(direction>0){
    rows[43]={...rows[43],open_price:101.15,high_price:101.32,low_price:101.12,close_price:101.28,volume:200};
    rows[44]={...rows[44],open_price:101.25,high_price:101.34,low_price:101.00,close_price:101.31,volume:120};
  } else {
    rows[43]={...rows[43],open_price:98.85,high_price:98.88,low_price:98.68,close_price:98.72,volume:200};
    rows[44]={...rows[44],open_price:98.75,high_price:99.00,low_price:98.66,close_price:98.69,volume:120};
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

assert.ok(source.includes("function analyzeCoreTrendContinuation"));
assert.ok(source.includes("CORE_TREND_CONTINUATION"));
assert.ok(source.includes("5M_TREND_CONTINUATION+BREAKOUT_RETEST"));
assert.ok(source.includes("corePullbackScalp: modeStats(\"CORE_PULLBACK_SCALP\")"));
assert.ok(source.includes("coreTrendContinuation: modeStats(\"CORE_TREND_CONTINUATION\")"));
assert.ok(source.includes('"PULLBACK_RECLAIM_VOLUME_OR_FRESHNESS_GATE"'));
assert.ok(source.includes("coreForecastChecks>=Math.min(3,coreTrendCandidateCount)")&&source.includes("otherForecastChecks>=6-Math.min(3,coreTrendCandidateCount)"));
assert.ok(source.includes('paperStorage.put("ciel:adaptive-learning:v1"'));
assert.ok(source.includes("advisorScanRaw"));
assert.ok(source.includes("advisorScan, feed:"));
assert.ok(source.includes("Core pullback scalps: "));
assert.ok(source.includes("5m trend continuation: "));
assert.ok(source.includes("CIEL deterministic core trend continuation guard"));
assert.ok(source.includes("LOCAL_CORE_TREND_CONTINUATION"));

assert.ok(!source.includes('paperStorage.put("ciel:adaptive-learning:v1").bind'));

console.log("PASS: bounded adaptive learning, core-market scheduling, separate /profits strategy buckets, and 5m breakout-retest long/short gates.");
