import assert from "node:assert/strict";
import { buildLeverUpProfitReport } from "../src/leverup-profits.js";

const statements = [];
const db = { prepare(sql) {
  statements.push(sql);
  return { async all() { return { results: [
    { position_hash: "0x1", symbol: "BTC", close_time: 1, net_pnl_after_fees_raw: "1500000000000000000", margin_token: "0x3bd359c1119da7da1d913d1c4d2b7c461115433a" },
    { position_hash: "0x2", symbol: "ETH", close_time: 2, net_pnl_after_fees_raw: "-500000000000000000", margin_token: "0x3bd359c1119da7da1d913d1c4d2b7c461115433a" },
  ] }; } };
} };
const report = await buildLeverUpProfitReport({
  env: { DB: db, LEVERUP_TRADER_ADDRESS: "0x1111111111111111111111111111111111111111" },
  fetchImpl: async (url) => new Response(JSON.stringify({ content: [
    { status: "OPEN", symbol: "BTC", side: "LONG", positionHash: "0xabc" },
    { status: "CLOSED", symbol: "ETH" },
  ], totalPages: 1 }), { status: 200, headers: { "content-type": "application/json" } }),
});
assert.match(report, /CIEL LIVE TRADING/);
assert.match(report, /WMON \(MON\): \+1\.0000 token units/);
assert.match(report, /1 currently open/);
assert.match(report, /Unrealized P&L: not reported/);
assert.doesNotMatch(report, /PAPER TRADING/);
console.log("PASS: live profits use reconciled LeverUp settlements and exchange open positions; no paper P&L leakage.");
