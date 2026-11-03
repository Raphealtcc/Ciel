import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile("reconstructed/patched-worker.js", "utf8");
assert.ok(source.includes('new Set(["BTC", "ETH", "MON", "SOL"])'), "SOL candle history must be added without dropping MON");
assert.ok(source.includes('interval: "1m"'));
assert.ok(source.includes("this.coreScalpCandles[symbol]"), "1m scalp candles must be retained in Durable Object state");
assert.ok(source.includes('this.state.storage.put("coreScalpCandles", this.coreScalpCandles)'), "1m scalp candle history must survive Durable Object restarts");
assert.ok(!source.includes("processedCandidateSymbols"), "trend candidates must not reserve a symbol before scalp evaluation");
assert.ok(source.includes("model='CIEL deterministic core scalp guard'"), "core scalp cooldown must be mode-specific");
assert.ok(source.includes("model NOT IN ('CIEL Statistical Ensemble v1','CIEL Statistical Ensemble v1 + technical gate','CIEL deterministic range guard','CIEL deterministic core scalp guard'"), "trend cooldown must ignore scalp and pre-review gate rows");
assert.ok(source.includes("if (forecastChecks >= 6 && !isScalpMode) continue;"), "trend review budget must not starve deterministic scalp candidates");
const blockedReview = source.match(/if \(reviewed\.verdict === "REJECT" \|\| reviewed\.verdict === "WAIT" && !waitFallback\) \{([\s\S]*?)\n    \}/);
assert.ok(blockedReview && /continue;/.test(blockedReview[1]) && !/return;/.test(blockedReview[1]), "a blocked candidate must not abort the whole advisor cycle");
assert.ok(source.includes('interval: "1m"'));
assert.ok(source.includes('mode:"CORE_PULLBACK_SCALP"'));
assert.ok(source.includes('"5M_TREND_FILTER","1M_PULLBACK","1M_RECLAIM","VOLUME_CONFIRMATION"'));
assert.ok(source.includes('requiredPaperMargin === null'));
assert.ok(source.includes('candidate.mode === "CORE_PULLBACK_SCALP"'));

const start = source.indexOf("function analyzeCorePullbackScalp");
const end = source.indexOf("async function runAdvisorCycle", start);
assert.ok(start >= 0 && end > start, "Core scalp analyzer must be present before the advisor cycle");
const context = vm.createContext({ __name() {} });
vm.runInContext(source.slice(start, end) + "\nglobalThis.analyze = analyzeCorePullbackScalp;", context);
const analyze = context.analyze;

const coreScalpCall = 'if (now - this.lastCoreScalpCandleAt >= 55e3) background.push(this.writeCoreScalpCandles(now));';
const sampleMethodAt = source.indexOf("async samplePrices(now)");
const backgroundDeclarationAt = source.indexOf("const background = [];", sampleMethodAt);
const coreScalpCallAt = source.indexOf(coreScalpCall, sampleMethodAt);
assert.equal(source.split(coreScalpCall).length - 1, 1, "core candle background task must be scheduled exactly once");
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

const flatFive = candles(36,0.0001,300_000,100);
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
assert.equal(longSignal.mode,"CORE_PULLBACK_SCALP");
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
assert.equal(shortSignal.mode, "CORE_PULLBACK_SCALP");
assert.ok(shortSignal.stopPct > 0 && shortSignal.stopPct <= 0.45, "short stop must fit the risk ceiling");

console.log("PASS: core scalp rejects stale, incomplete, flat and no-pullback data, accepts long and short pullback/reclaims, and evaluates scalp/trend candidates independently.");
