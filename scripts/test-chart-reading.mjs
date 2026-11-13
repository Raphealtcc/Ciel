import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const source=await readFile("reconstructed/patched-worker.js","utf8");
const start=source.indexOf("function analyzeCoreTrendContinuation(");
const end=source.indexOf('__name(analyzeCoreTrendContinuation,"analyzeCoreTrendContinuation");',start);
assert.ok(start>=0&&end>start,"enhanced chart detector must exist");
const context=vm.createContext({__name(){}});
vm.runInContext(source.slice(start,end+ '__name(analyzeCoreTrendContinuation,"analyzeCoreTrendContinuation");'.length)+";globalThis.testFn=analyzeCoreTrendContinuation;",context);
const analyze=context.testFn;
const now=1800000000000;
function candles(direction){
  const rows=[];
  for(let i=0;i<55;i++){
    // Build a genuine sequence of higher highs/higher lows (or lower highs/lower lows).
    const base=100+direction*i*0.025+direction*0.10*Math.sin(i*Math.PI/2);
    rows.push({
      open_ts_ms:now-(55-i)*300e3,
      close_ts_ms:now-(54-i)*300e3-1000,
      open_price:base-direction*0.015,
      high_price:base+0.02,
      low_price:base-0.02,
      close_price:base+direction*0.015,
      volume:100
    });
  }
  const range=rows.slice(30,50);
  const level=direction>0?Math.max(...range.map(c=>c.high_price)):Math.min(...range.map(c=>c.low_price));
  if(direction>0){
    rows[53]={...rows[53],open_price:level+0.02,high_price:level+0.07,low_price:level+0.01,close_price:level+0.055,volume:180};
    rows[54]={...rows[54],open_price:level+0.065,high_price:level+0.11,low_price:level-0.005,close_price:level+0.095,volume:110};
  }else{
    rows[53]={...rows[53],open_price:level-0.02,high_price:level-0.01,low_price:level-0.07,close_price:level-0.055,volume:180};
    rows[54]={...rows[54],open_price:level-0.065,high_price:level+0.005,low_price:level-0.11,close_price:level-0.095,volume:110};
  }
  return rows;
}
const long=analyze("BTC",candles(1),now);
const short=analyze("ETH",candles(-1),now);
assert.equal(long?.side,"LONG","clear bullish structure should classify long");
assert.equal(long?.mode,"TREND_HOLD");
assert.equal(long?.holdMinutes,180);
assert.equal(short?.side,"SHORT","clear bearish structure should classify short");
assert.ok(long.scoreComponents.includes("5M_HIGHER_HIGHS_HIGHER_LOWS"));
assert.ok(short.scoreComponents.includes("5M_MACD_MOMENTUM"));
assert.ok(long.chartEvidence.rsi>=52&&long.chartEvidence.rsi<=76);
assert.ok(short.chartEvidence.rsi>=24&&short.chartEvidence.rsi<=48);
assert.ok(long.stopPct<=0.45&&short.stopPct<=0.45);
assert.equal(analyze("BTC",candles(1).slice(0,20),now),null);
const stale=candles(1).map(c=>({...c,close_ts_ms:c.close_ts_ms-60*60e3}));
assert.equal(analyze("BTC",stale,now),null,"stale candles must be rejected");
const noVolume=candles(1).map(c=>({...c,volume:1}));
assert.equal(analyze("BTC",noVolume,now),null,"volume must confirm breakout");
const existingTrendPullback=source.includes("function analyzeTrendPullbackEntry(");
const existingTrend=source.includes('mode === "TREND_HOLD"');
assert.ok(existingTrendPullback&&existingTrend,"trend pullback and trend-hold paths must remain present");
console.log("PASS: chart structure, EMA, MACD, RSI, breakout/retest, volume, freshness, and long/short classifications.");
