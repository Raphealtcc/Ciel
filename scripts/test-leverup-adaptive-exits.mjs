import assert from "node:assert/strict";
import { evaluateAdaptiveLeverUpExit } from "../src/leverup-adaptive-exits.js";

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

const short = {...long,isLong:false,stopLossRaw:String(101n*10n**18n)};
const shortState=Array.from({length:10},(_,i)=>({at:3000+i*60000,price:String(BigInt(110-i)*10n**18n)}));
const shortTrail=evaluateAdaptiveLeverUpExit({
  position:short,currentPriceRaw:String(99n*10n**18n),
  state:{history:shortState,highWaterRaw:String(110n*10n**18n),lowWaterRaw:String(101n*10n**18n)},
  pairView:{slippageConfig:{onePercentDepthAboveUsdRaw:"100000",onePercentDepthBelowUsdRaw:"100000"}},now:3000+10*60000,
});
assert.equal(shortTrail.action,"UPDATE_TP_SL");
assert.ok(BigInt(shortTrail.stopLossRaw)<BigInt(short.stopLossRaw),"short stop may only tighten downward");
console.log("PASS: adaptive warm-up, multi-factor reversal, long/short trailing direction, and TP preservation.");
