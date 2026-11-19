import assert from "node:assert/strict";
import { evaluateAdaptiveLeverUpExit } from "../src/leverup-adaptive-exits.js";

const raw = (price) => String(BigInt(Math.round(price * 1_000_000)) * 10n ** 12n);
const history = (prices, start = 1_000) => prices.map((price, i) => ({ at: start + i * 60_000, price }));
const position = { positionHash: "0x" + "ab".repeat(32), qtyRaw: "1000", entryPriceRaw: raw(100), stopLossRaw: raw(98), takeProfitRaw: raw(103), isLong: true };
const targetExtension = evaluateAdaptiveLeverUpExit({
  position: { ...position, takeProfitRaw: "0" }, currentPriceRaw: raw(103.1),
  state: { history: history([100, 100.2, 100.4, 100.7, 101, 101.4, 101.8, 102.2, 102.7, 103]), highWaterPrice: 103 }, now: 601_000,
});
assert.equal(targetExtension.action, "UPDATE_TP_SL");
assert.equal(targetExtension.reason, "PATIENT_TREND_TRAILING_STOP");
assert.equal(targetExtension.takeProfitRaw, "0", "trailing strategy must never restore a fixed venue TP");
assert.ok(BigInt(targetExtension.stopLossRaw) > BigInt(position.stopLossRaw), "favourable movement should ratchet the emergency stop forward");
const reversal = evaluateAdaptiveLeverUpExit({
  position: { ...position, entryPriceRaw: raw(100), takeProfitRaw: raw(108), stopLossRaw: raw(97) },
  currentPriceRaw: raw(104),
  // Keep the fixture aligned with the production rule: reversal closes are only confirmed
  // after at least 12 samples and four consecutive adverse samples.
  state: { history: history([112, 111, 110, 109, 108, 107, 106, 105, 104.8, 104.5, 104.2]), highWaterPrice: 110, peakFavourablePct: 10 }, now: 661_000,
});
assert.equal(reversal.action, "MARKET_CLOSE");
assert.equal(reversal.reason, "ADAPTIVE_PROFIT_REVERSAL");
assert.equal(reversal.reverseConfirmed, true);
const hardStop = evaluateAdaptiveLeverUpExit({ position, currentPriceRaw: raw(97.5), state: {}, now: 700_000 });
assert.equal(hardStop.action, "MARKET_CLOSE");
assert.equal(hardStop.reason, "HARD_STOP_TRIGGERED");
const noFixedTargetExit=evaluateAdaptiveLeverUpExit({position:{...position,takeProfitRaw:"0"},currentPriceRaw:raw(104),state:{history:history([100,101,102,103]),highWaterPrice:103},now:601_000});
assert.notEqual(noFixedTargetExit.reason,"TAKE_PROFIT_TRIGGERED","dynamic manager must not close on suggested target");
console.log("PASS: LeverUp raw-price conversion, no-fixed-TP trailing stop, profit reversal and hard-stop priority");
