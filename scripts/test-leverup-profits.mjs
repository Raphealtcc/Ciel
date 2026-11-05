import assert from "node:assert/strict";
import { buildLeverUpProfitReport } from "../src/leverup-profits.js";

const db = { prepare(sql) {
  assert.match(sql, /leverup_settlement_reconciliations/);
  return { async all() { return { results: [
    { position_hash: "0x1", symbol: "BTC", close_time: 1, net_pnl_after_fees_raw: "1500000000000000000", margin_token: "0x3bd359c1119da7da1d913d1c4d2b7c461115433a" },
    { position_hash: "0x2", symbol: "ETH", close_time: 2, net_pnl_after_fees_raw: "-500000000000000000", margin_token: "0x3bd359c1119da7da1d913d1c4d2b7c461115433a" },
  ] }; } };
} };
const pairBase = "0x2222222222222222222222222222222222222222";
const positionHash = "0x" + "ab".repeat(32);
const publicClient = {
  async readContract({ functionName, args }) {
    assert.equal(functionName, "getPositionsV4");
    assert.equal(args[1], pairBase);
    return [{
      positionHash,
      pair: "BTC/USD",
      pairBase,
      isLong: true,
      marginToken: "0x3bd359c1119da7da1d913d1c4d2b7c461115433a",
      qty: 10n ** 18n,
      entryPrice: 190n * 10n ** 10n,
    }];
  },
};
const fetchImpl = async (url, init = {}) => {
  if (String(url).includes("/open-positions")) {
    return new Response(JSON.stringify({ content: [{ positionHash, pairBase, symbol: "BTC" }] }), { status: 200 });
  }
  if (String(url).includes("/oracle/price/pairs/latest")) {
    assert.equal(init.method, "POST");
    return new Response(JSON.stringify({ prices: { [pairBase]: String(200n * 10n ** 10n) } }), { status: 200 });
  }
  throw new Error("Unexpected LeverUp request: " + url);
};
const report = await buildLeverUpProfitReport({
  env: {
    DB: db,
    LEVERUP_TRADER_ADDRESS: "0x1111111111111111111111111111111111111111",
    LEVERUP_RPC_URL: "https://rpc2.monad.xyz",
  },
  fetchImpl,
  publicClient,
});
assert.match(report, /CIEL LIVE TRADING/);
assert.match(report, /WMON \(MON\): \+1\.0000 token units/);
assert.match(report, /1 currently open/);
assert.match(report, /Total gross unrealized: \+10\.0000 USD/);
assert.match(report, /LONG BTC\/USD: \+10\.0000 USD/);
assert.match(report, /gross before close fees \/ funding/i);
assert.doesNotMatch(report, /PAPER TRADING/);
console.log("PASS: live realized P&L and on-chain/oracle mark-to-market unrealized P&L are reported separately.");

const degraded = await buildLeverUpProfitReport({
  env: {
    DB: db,
    LEVERUP_TRADER_ADDRESS: "0x1111111111111111111111111111111111111111",
    LEVERUP_RPC_URL: "https://rpc2.monad.xyz",
  },
  fetchImpl: async () => { throw new Error("oracle temporarily unavailable"); },
  publicClient,
});
assert.match(degraded, /WMON \\(MON\\): \\+1\\.0000 token units/);
assert.match(degraded, /UNAVAILABLE — oracle temporarily unavailable/);
assert.match(degraded, /open-position count unavailable/);
console.log("PASS: a mark/oracle outage does not erase realized P&L or report a false zero.");

