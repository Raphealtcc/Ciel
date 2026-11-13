import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile("reconstructed/patched-worker.js", "utf8");
assert.ok(source.includes('new Set(["BTC", "ETH", "MON", "SOL", "BNB", "HYPE", "ADA", "PUMP"])'), "SOL candle history must be added without dropping MON");
assert.ok(source.includes('const coreScalpSymbols = ["BTC","ETH","SOL","BNB","HYPE","ADA","PUMP"]'), "core scalp feed must exclude ZEC while retaining ADA and PUMP");
assert.ok(source.includes('interval: "1m"'));
assert.ok(source.includes("this.coreScalpCandles[symbol]"), "1m scalp candles must be retained in Durable Object state");
assert.ok(source.includes('this.state.storage.put("coreScalpCandles", this.coreScalpCandles)'), "1m scalp candle history must survive Durable Object restarts");
assert.ok(source.includes('this.xyzQntMid = values[24] || null;'), "QNT mid must restore from its own storage slot after adding core candle state");
assert.ok(source.includes('this.lastXyzQntRefreshAt = Number(values[25]) || 0;'), "QNT refresh timestamp must restore from its own slot to avoid excess REST polling");
assert.ok(source.includes('this.historyBootstrapDone = values[26] === true;'), "history bootstrap completion flag must restore from its own slot");
assert.ok(source.includes('this.lastHistoryBootstrapAt = Number(values[27]) || 0;'), "history bootstrap timestamp must restore from its own slot");
assert.ok(!source.includes("processedCandidateSymbols"), "trend candidates must not reserve a symbol before scalp evaluation");
assert.ok(source.includes('const reviewCooldownKey = "ciel:advisor:review:trend:" + candidate.symbol;'), "trend strategies share one bounded KV cooldown");
assert.ok(!source.includes('"ciel:advisor:review:ai:" + candidate.symbol'), "trend-only execution does not create a separate scalp/AI cooldown path");
assert.ok(source.includes('const isScalpMode = false;'), "trend entries use the standard trend review path");
assert.ok(source.includes("if (!isScalpMode) { if(forecastChecks>=6) continue;"), "trend review budget remains bounded");
assert.ok(source.includes("const cooldownMs = trendCooldownMs;"), "trend entries use the configured trend cooldown");
assert.ok(source.includes("1M_SWING_REVERSAL+RECLAIM"), "counter-trend reversal detector must be present");
const blockedReview = source.match(/if \(reviewed\.verdict === "REJECT" \|\| reviewed\.verdict === "WAIT" && !waitFallback\) \{([\s\S]*?)\n    \}/);
assert.ok(blockedReview && /continue;/.test(blockedReview[1]) && !/return;/.test(blockedReview[1]), "a blocked candidate must not abort the whole advisor cycle");
assert.ok(source.includes('interval: "1m"'));
assert.ok(source.includes('mode:"TREND_HOLD",holdMinutes:180'));
assert.ok(!source.includes('mode:"RANGE_SCALP"'), "range strategy cannot generate new entries");
assert.ok(!source.includes("function analyzeMicroMomentumContinuation"), "micro-momentum breakout strategy is removed");
assert.ok(source.includes("const baseSignals = [analyzeCandleLevelReversal"), "level-reversal and trend analyzers must run independently; a truthy first result must not hide the second");
assert.ok(source.includes("latest.v>=averageVolume*0.65"), "trend pullback volume confirmation should not discard every moderate-volume reclaim");
assert.ok(source.includes('"5M_TREND_FILTER","1M_PULLBACK","1M_RECLAIM","VOLUME_CONFIRMATION"'));
assert.ok(source.includes('requiredPaperMargin === null'));
assert.ok(source.includes('candidate.strategy === "5M_TREND+1M_PULLBACK+RECLAIM"'));

const start = source.indexOf("function analyzeTrendPullbackEntry");
const end = source.indexOf("async function runAdvisorCycle", start);
assert.ok(start >= 0 && end > start, "Trend pullback analyzer must be present before the advisor cycle");
const context = vm.createContext({ __name() {} });
vm.runInContext(source.slice(start, end) + "\nglobalThis.analyze = analyzeTrendPullbackEntry;", context);
const analyze = context.analyze;

const coreScalpCall = 'if (now - this.lastCoreScalpCandleAt >= 55e3) background.push(this.writeCoreScalpCandles(now));';
const sampleMethodAt = source.indexOf("async samplePrices(now)");
const backgroundDeclarationAt = source.indexOf("const background = [];", sampleMethodAt);
const coreScalpCallAt = source.indexOf(coreScalpCall, sampleMethodAt);
assert.equal(source.split(coreScalpCall).length - 1, 1, "trend-entry candle background task must be scheduled exactly once");
assert.ok(backgroundDeclarationAt >= 0 && coreScalpCallAt > backgroundDeclarationAt,
  "core candle background task must be queued after initialization; prevents the deployed background TDZ ReferenceError");

const now = 1_800_000_000_000;
const candles = (count, step, interval, base, closeOffset=0) => Array.from({length:count},(_,i)=>{
  const close=base+i*step+closeOffset;
  const open=close-step*0.2;
  return {open_ts_ms:now-(count-i)*interval,close_ts_ms:now-(count-i)*interval+interval-1,
    open_price:open,high_price:Math.max(open,close)+Math.abs(step)*0.25,
    low_price:Math.min(open,close)-Math.abs(step)*0.25,close_price:close,volume:100};
});
const five = candles(36,0.12,300_000,100);
const one = candles(30,0.025,60_000,103);
assert.equal(analyze("BTC",one,five,now),null,"monotonic trend without a pullback/reclaim must not trigger");
assert.equal(analyze("BTC",one,five,now+10*60_000),null,"stale candles must never trigger");
assert.equal(analyze("BTC",one.slice(-10),five,now),null,"insufficient 1m history must never trigger");

const flatFive = candles(36,0,300_000,100);
assert.equal(analyze("ETH",one,flatFive,now),null,"flat 5m regime must not trigger");

// Positive fixture: rising 5m regime, several red 1m pullback candles near EMA9,
// then a closed bullish reclaim that closes above the previous candle's high.
const validLong = one.map(c => ({...c}));
const pullback = [
  {open_price:103.650,high_price:103.655,low_price:103.580,close_price:103.600},
  {open_price:103.620,high_price:103.625,low_price:103.560,close_price:103.580},
  {open_price:103.600,high_price:103.605,low_price:103.550,close_price:103.580},
  {open_price:103.600,high_price:103.605,low_price:103.560,close_price:103.580},
  {open_price:103.580,high_price:103.690,low_price:103.570,close_price:103.680}
];
for (let j=0;j<pullback.length;j++) Object.assign(validLong[25+j],pullback[j]);
const longSignal = analyze("BTC",validLong,five,now);
assert.ok(longSignal, "valid closed-candle long pullback/reclaim should trigger");
assert.equal(longSignal.side,"LONG");
assert.equal(longSignal.mode,"TREND_HOLD");
assert.ok(longSignal.stopPct>0 && longSignal.stopPct<=0.45, "long stop must fit the risk ceiling");

const mirror = (rows) => rows.map((c) => ({
  ...c,
  open_price: 200 - c.open_price,
  high_price: 200 - c.low_price,
  low_price: 200 - c.high_price,
  close_price: 200 - c.close_price,
}));
const shortSignal = analyze("SOL", mirror(validLong), mirror(five), now);
assert.ok(shortSignal, "valid closed-candle short pullback/reclaim should trigger");
assert.equal(shortSignal.side, "SHORT");
assert.equal(shortSignal.mode, "TREND_HOLD");
assert.ok(shortSignal.stopPct > 0 && shortSignal.stopPct <= 0.45, "short stop must fit the risk ceiling");


// Counter-trend reversal fixtures: a declining market bottoms, retests, then reclaims.
const reversalLong = Array.from({length:30},(_,i)=>{
  let close=i<=23?101-i*0.04:i===24?100.05:i===25?100.02:i===26?99.98:i===27?99.95:i===28?99.92:100.30;
  let open=close+0.01,high=open+0.02,low=close-0.02,volume=100;
  if(i===27){open=100.02;high=100.04;low=99.92;close=99.95;volume=120;}
  if(i===28){open=99.97;high=100.01;low=99.95;close=99.96;volume=140;}
  if(i===29){open=99.90;high=100.35;low=99.95;close=100.30;volume=220;}
  return {open_ts_ms:now-(30-i)*60e3,close_ts_ms:now-(30-i)*60e3+60e3-1,open_price:open,high_price:high,low_price:low,close_price:close,volume};
});
assert.equal(analyze("BTC",reversalLong,flatFive,now),null,"1m reversal without a closed 5m reversal confirmation must be rejected");
const reversalFive = flatFive.map(c => ({...c}));
Object.assign(reversalFive[35], {open_price:100.0,high_price:100.25,low_price:99.99,close_price:100.2});
const reversalSignal=analyze("BTC",reversalLong,reversalFive,now);
assert.ok(reversalSignal,"counter-trend 1m reversal with a closed 5m reversal confirmation should trigger");
assert.equal(reversalSignal.side,"LONG");
assert.equal(reversalSignal.strategy,"1M_SWING_REVERSAL+RECLAIM");
assert.ok(reversalSignal.scoreComponents.includes("5M_REVERSAL_CONFIRMATION"));
assert.ok(reversalSignal.confidence>=0.72&&reversalSignal.stopPct<=0.45);
const reversalShort=analyze("SOL",mirror(reversalLong),mirror(reversalFive),now);
assert.ok(reversalShort,"mirrored counter-trend short reversal with 5m confirmation should trigger");
assert.equal(reversalShort.side,"SHORT");
assert.equal(reversalShort.strategy,"1M_SWING_REVERSAL+RECLAIM");
assert.ok(reversalShort.scoreComponents.includes("5M_REVERSAL_CONFIRMATION"));

console.log("PASS: core scalp rejects stale, incomplete, flat and no-pullback data, accepts long and short pullback/reclaims, and evaluates scalp/trend candidates independently.");
