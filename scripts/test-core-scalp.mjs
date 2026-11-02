import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile("reconstructed/patched-worker.js", "utf8");
assert.ok(source.includes('new Set(["BTC", "ETH", "SOL"])'));
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

const now = 1_800_000_000_000;
const candles = (count, step, interval, base, closeOffset=0) => Array.from({length:count},(_,i)=>{
  const close=base+i*step+closeOffset;
  const open=close-step*0.2;
  return {open_ts_ms:now-(count-i)*interval,close_ts_ms:now-(count-i)*interval+interval-1,
    open_price:open,high_price:Math.max(open,close)+step*0.25,
    low_price:Math.min(open,close)-step*0.25,close_price:close,volume:100};
});
const five = candles(36,0.12,300_000,100);
const one = candles(30,0.025,60_000,103);
assert.equal(analyze("BTC",one,five,now),null,"monotonic trend without a pullback/reclaim must not trigger");
assert.equal(analyze("BTC",one,five,now+10*60_000),null,"stale candles must never trigger");
assert.equal(analyze("BTC",one.slice(-10),five,now),null,"insufficient 1m history must never trigger");

const flatFive = candles(36,0.0001,300_000,100);
assert.equal(analyze("ETH",one,flatFive,now),null,"flat 5m regime must not trigger");

console.log("PASS: core scalp is candle-gated, rejects stale/insufficient data and requires a directional 5m regime.");
