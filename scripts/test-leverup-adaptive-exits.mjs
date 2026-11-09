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
