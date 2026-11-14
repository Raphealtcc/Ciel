import assert from "node:assert/strict";
import { evaluateAdaptiveLeverUpExit } from "../src/leverup-adaptive-exits.js";
import { selectLeverUpPositionAction } from "../src/leverup-coordinator.js";

const long = {
  positionHash: "0x" + "ab".repeat(32), qtyRaw: "1000", entryPriceRaw: "100000000000000000000",
  stopLossRaw: "99000000000000000000", takeProfitRaw: "103000000000000000000", isLong: true,
};
const rising = Array.from({length:10},(_,i)=>({at:1000+i*60000,price:String(BigInt(100+i)*10n**18n)}));
const trail = evaluateAdaptiveLeverUpExit({
  position: long, currentPriceRaw:String(111n*10n**18n),
  state:{history:rising,highWaterRaw:String(110n*10n**18n),lowWaterRaw:String(100n*10n**18n)},
  pairView:{slippageConfig:{onePercentDepthAboveUsdRaw:"100000",onePercentDepthBelowUsdRaw:"100000"}},now:1000+10*60000,
});
assert.equal(trail.action,"UPDATE_TP_SL","rising long should tighten a trailing stop after enough samples");
assert.ok(BigInt(trail.stopLossRaw)>BigInt(long.stopLossRaw),"long stop may only tighten upward");
assert.equal(trail.takeProfitRaw,long.takeProfitRaw,"adaptive trailing must preserve the existing take-profit");

const deteriorating = Array.from({length:10},(_,i)=>({at:2000+i*60000,price:String(BigInt(110-i)*10n**18n)}));
const reversal = evaluateAdaptiveLeverUpExit({
  position:{...long,entryPriceRaw:String(95n*10n**18n)},
  currentPriceRaw:String(101n*10n**18n),
  state:{history:deteriorating,highWaterRaw:String(110n*10n**18n),lowWaterRaw:String(101n*10n**18n)},
  pairView:{slippageConfig:{onePercentDepthAboveUsdRaw:"100000",onePercentDepthBelowUsdRaw:"1000"}},now:2000+10*60000,
});
assert.equal(reversal.action,"MARKET_CLOSE","three aligned deterioration factors plus liquidity imbalance should trigger a balanced reversal exit");

const short = {...long,isLong:false,stopLossRaw:String(106n*10n**18n)};
const shortState=Array.from({length:10},(_,i)=>({at:3000+i*60000,price:String(BigInt(110-i)*10n**18n)}));
const shortTrail=evaluateAdaptiveLeverUpExit({
  position:short,currentPriceRaw:String(99n*10n**18n),
  state:{history:shortState,highWaterRaw:String(110n*10n**18n),lowWaterRaw:String(101n*10n**18n)},
  pairView:{slippageConfig:{onePercentDepthAboveUsdRaw:"100000",onePercentDepthBelowUsdRaw:"100000"}},now:3000+10*60000,
});
assert.equal(shortTrail.action,"UPDATE_TP_SL");
assert.ok(BigInt(shortTrail.stopLossRaw)<BigInt(short.stopLossRaw),"short stop may only tighten downward");
const profitGivebackHistory = [110,109,108,107,106,105,104,103].map((price,i)=>({at:4000+i*60000,price:String(BigInt(price)*10n**18n)}));
const profitLock = evaluateAdaptiveLeverUpExit({
  position: long,
  currentPriceRaw: String(104n*10n**18n),
  state: { history: profitGivebackHistory, highWaterRaw: String(110n*10n**18n), lowWaterRaw: String(100n*10n**18n) },
  pairView: { slippageConfig: { onePercentDepthAboveUsdRaw: "100000", onePercentDepthBelowUsdRaw: "100000" } },
  now: 4000+8*60000,
});
assert.equal(profitLock.action, "MARKET_CLOSE", "armed peak-profit giveback with confirmed local deterioration must close live position");
assert.equal(profitLock.reason, "PROFIT_PROTECTION_PEAK_GIVEBACK");
assert.ok(profitLock.peakFavourablePct >= 4);
assert.ok(profitLock.givebackPct >= profitLock.peakFavourablePct * 0.45);
const belowEntryGiveback = evaluateAdaptiveLeverUpExit({
  position: long,
  currentPriceRaw: String(98n * 10n**18n),
  state: {
    history: [105,104,103,102,101,100,99,98].map((price,i)=>({at:5000+i*60000,price:String(BigInt(price)*10n**18n)})),
    highWaterRaw: String(110n*10n**18n), lowWaterRaw: String(98n*10n**18n),
  },
  pairView: { slippageConfig: { onePercentDepthAboveUsdRaw: "100000", onePercentDepthBelowUsdRaw: "100000" } },
  now: 5000+8*60000,
});
assert.equal(belowEntryGiveback.action, "MARKET_CLOSE",
  "armed peak-profit giveback with confirmed reversal must protect the gain even if mark has slipped slightly below entry");
assert.equal(belowEntryGiveback.reason, "PROFIT_PROTECTION_PEAK_GIVEBACK");
console.log("PASS: adaptive warm-up, multi-factor reversal, long/short trailing direction, and TP preservation.");

const nearTargetHistory = [100,101,102,103,104,105,106,105.8,105.5].map((price,i)=>({at:6000+i*60000,price:String(BigInt(Math.round(price*100))*10n**16n)}));
const nearTargetExit = evaluateAdaptiveLeverUpExit({
  position: {...long, takeProfitRaw:String(107n*10n**18n)},
  currentPriceRaw:String(1055n*10n**17n),
  state:{history:nearTargetHistory,highWaterRaw:String(106n*10n**18n),lowWaterRaw:String(100n*10n**18n)},
  pairView:{slippageConfig:{onePercentDepthAboveUsdRaw:"100000",onePercentDepthBelowUsdRaw:"100000"}},
  now:6000+8*60000,
});
assert.equal(nearTargetExit.action,"MARKET_CLOSE","near-target reversal must bank profit without waiting for exact TP");
assert.equal(nearTargetExit.reason,"TAKE_PROFIT_APPROACH_REVERSAL");

const nearTargetFast = evaluateAdaptiveLeverUpExit({
  position: { ...long, takeProfitRaw: String(103n * 10n**18n) },
  currentPriceRaw: String(1022n * 10n**17n),
  state: {
    history: [102.5,102.4,102.3].map((price,i)=>({at:9000+i*60000,price:String(BigInt(Math.round(price*100))*10n**16n)})),
    highWaterRaw: String(1025n*10n**17n), lowWaterRaw: String(100n*10n**18n),
  },
  pairView: { slippageConfig: { onePercentDepthAboveUsdRaw: "100000", onePercentDepthBelowUsdRaw: "100000" } },
  now: 9000+3*60000,
});
assert.equal(nearTargetFast.action,"MARKET_CLOSE","near-target reversal must trigger after three monitor samples");
assert.equal(nearTargetFast.reason,"TAKE_PROFIT_APPROACH_REVERSAL");
assert.equal(selectLeverUpPositionAction({
  fixedAction: { action: "WAIT", reason: "MINIMUM_HOLD_NOT_REACHED" },
  adaptive: nearTargetFast,
}).action,"MARKET_CLOSE","profit protection must use the market-close path during minimum hold");
console.log("PASS: fast near-target reversal exit and minimum-hold priority.");

{
  const E18 = 10n ** 18n;
  const px = (p) => String(BigInt(Math.round(p * 100)) * 10n ** 16n);
  const series = (arr, t0) => arr.map((p, i) => ({ at: t0 + i * 60000, price: px(p) }));
  const depth = { slippageConfig: { onePercentDepthAboveUsdRaw: "100000", onePercentDepthBelowUsdRaw: "100000" } };
  const longPos = { positionHash: "0x" + "ab".repeat(32), qtyRaw: "1000", entryPriceRaw: String(100n * E18), stopLossRaw: String(99n * E18), takeProfitRaw: String(103n * E18), isLong: true };
  const shortPos = { ...longPos, isLong: false, stopLossRaw: String(101n * E18), takeProfitRaw: String(97n * E18) };
  const fall = [100, 99.9, 99.8, 99.7, 99.6, 99.5, 99.4, 99.3];
  const adverseLong = evaluateAdaptiveLeverUpExit({ position: longPos, currentPriceRaw: px(99.3), state: { history: series(fall.slice(0, -1), 7000), highWaterRaw: px(100), lowWaterRaw: px(99.4) }, pairView: depth, now: 7000 + 7 * 60000 });
  assert.equal(adverseLong.action, "MARKET_CLOSE", "a confirmed slide 70% of the way to the stop must be cut before the exchange stop");
  assert.equal(adverseLong.reason, "ADAPTIVE_ADVERSE_CUT");
  const shallowLong = evaluateAdaptiveLeverUpExit({ position: longPos, currentPriceRaw: px(99.5), state: { history: series([100, 99.95, 99.9, 99.85, 99.8, 99.7, 99.6], 8000), highWaterRaw: px(100), lowWaterRaw: px(99.6) }, pairView: depth, now: 8000 + 7 * 60000 });
  assert.notEqual(shallowLong.reason, "ADAPTIVE_ADVERSE_CUT", "a loss under 60% of the stop distance must not be cut");
  const bouncingLong = evaluateAdaptiveLeverUpExit({ position: longPos, currentPriceRaw: px(99.35), state: { history: series([100, 99.5, 99.3, 99.2, 99.25, 99.3], 9000), highWaterRaw: px(100), lowWaterRaw: px(99.2) }, pairView: depth, now: 9000 + 6 * 60000 });
  assert.notEqual(bouncingLong.reason, "ADAPTIVE_ADVERSE_CUT", "a deep but recovering position must not be cut");
  const fewSamples = evaluateAdaptiveLeverUpExit({ position: longPos, currentPriceRaw: px(99.3), state: { history: series([99.6, 99.4], 9500), highWaterRaw: px(100), lowWaterRaw: px(99.4) }, pairView: depth, now: 9500 + 2 * 60000 });
  assert.notEqual(fewSamples.reason, "ADAPTIVE_ADVERSE_CUT", "adverse cut needs at least six samples");
  const rise = [100, 100.1, 100.2, 100.3, 100.4, 100.5, 100.6, 100.7];
  const adverseShort = evaluateAdaptiveLeverUpExit({ position: shortPos, currentPriceRaw: px(100.7), state: { history: series(rise.slice(0, -1), 10000), highWaterRaw: px(100.6), lowWaterRaw: px(100) }, pairView: depth, now: 10000 + 7 * 60000 });
  assert.equal(adverseShort.reason, "ADAPTIVE_ADVERSE_CUT", "short side must mirror the long-side adverse cut");
  const stopAboveEntry = evaluateAdaptiveLeverUpExit({ position: { ...longPos, stopLossRaw: String(101n * E18) }, currentPriceRaw: px(99.3), state: { history: series(fall.slice(0, -1), 11000), highWaterRaw: px(100), lowWaterRaw: px(99.4) }, pairView: depth, now: 11000 + 7 * 60000 });
  assert.notEqual(stopAboveEntry.reason, "ADAPTIVE_ADVERSE_CUT", "a stop on the profit side of entry is not a loss-side stop");
  const noStop = evaluateAdaptiveLeverUpExit({ position: { ...longPos, stopLossRaw: "0" }, currentPriceRaw: px(99.3), state: { history: series(fall.slice(0, -1), 12000), highWaterRaw: px(100), lowWaterRaw: px(99.4) }, pairView: depth, now: 12000 + 7 * 60000 });
  assert.notEqual(noStop.reason, "ADAPTIVE_ADVERSE_CUT", "no configured stop means no adverse-cut reference");
  console.log("PASS: adaptive adverse cut fires only on confirmed slides past 60% of the stop distance.");
}
