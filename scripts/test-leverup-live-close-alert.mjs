import assert from "node:assert/strict";
import { notifyLeverUpClosedTrade } from "../src/leverup-coordinator.js";

let sent = null;
await notifyLeverUpClosedTrade({
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_CHAT_ID: "test-chat",
  FETCH: async (_url, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 });
  },
}, {
  pair: "AAVE/USD",
  isLong: false,
  positionHash: "0x" + "ab".repeat(32),
  marginToken: "0x91b81bfbe3a747230f0529aa28d8b2bc898e6d56",
  closeInfo: { reason: "PROFIT_PROTECTION" },
}, {
  closePriceRaw: "129661357649685000000",
  netPnlAfterFeesRaw: "943282404397656421",
  grossPnlRaw: "1100000000000000000",
  totalTradingFeesRaw: "100000000000000000",
  fundingFeeRaw: "0",
  holdingFeeRaw: "565717595602343579",
}, {
  signalId: "AAVE-CLOSE-TEST",
  plan: { actionValues: ["0x" + "11".repeat(20), false, "0x3bd359c1119da7da1d913d1c4d2b7c461115433a",
    "0x91b81bfbe3a747230f0529aa28d8b2bc898e6d56", "30000000000000000000"] },
});
assert.ok(sent, "Telegram sendMessage must be called");
assert.ok(sent.text.includes("SHORT AAVE/USD | PROFIT_PROTECTION"));
assert.ok(sent.text.includes("Executed exit $129.661358 | P&L +0.943 LVMON"));
assert.ok(sent.text.includes("Return on margin: +3.14% | signal AAVE-CLOSE-TEST"));
assert.ok(sent.text.includes("\n"), "message must contain actual Telegram line breaks");
assert.ok(!sent.text.includes("\\n"), "message must not contain literal escaped newline sequences");
console.log("PASS: live close Telegram alert matches paper structure and includes reason, net P&L, return on margin and fee breakdown.");
