import assert from "node:assert/strict";
import { buildLeverUpProfitReport } from "../src/leverup-profits.js";

const db = { prepare(sql) {
  if (sql.includes("leverup_settlement_reconciliations")) {
    return { async all() { return { results: [
      { position_hash: "0x1", symbol: "BTC", close_time: 1, net_pnl_after_fees_raw: "1500000000000000000", margin_token: "0x91b81bfbe3a747230f0529aa28d8b2bc898e6d56" },
      { position_hash: "0x2", symbol: "ETH", close_time: 2, net_pnl_after_fees_raw: "-500000000000000000", margin_token: "0x91b81bfbe3a747230f0529aa28d8b2bc898e6d56" },
    ] }; } };
  }
  assert.match(sql, /leverup_execution_intents/);
  return { async all() { return { results: [
    { signal_id: "NXRPLMW3GVCO0", status: "REJECTED", last_error: "insufficient transfers", symbol: "XRP", side: "LONG" },
    { signal_id: "NTEST", status: "PENDING", last_error: null, symbol: "BTC", side: "SHORT" },
  ] }; } };
} };
const pairBase = "0x2222222222222222222222222222222222222222";
const lvmonPairBase = "0x3333333333333333333333333333333333333333";
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
      marginToken: "0x91b81bfbe3a747230f0529aa28d8b2bc898e6d56",
      margin: 2n * 10n ** 18n,
      qty: 10n ** 18n,
      entryPrice: 190n * 10n ** 10n,
    }];
  },
};
const fetchImpl = async (url, init = {}) => {
  if (String(url).includes("/v1/pairs")) {
    return new Response(JSON.stringify({ content: [{ symbol: "LVMON", base: lvmonPairBase }] }), { status: 200 });
  }
  if (String(url).includes("/open-positions")) {
    return new Response(JSON.stringify({ content: [{ positionHash, pairBase, symbol: "BTC" }] }), { status: 200 });
  }
  if (String(url).includes("/oracle/price/pairs/latest")) {
    assert.equal(init.method, "POST");
    const requested = JSON.parse(init.body).pairBases;
    const prices = {};
    for (const base of requested) prices[base] = String(base === lvmonPairBase ? 2n * 10n ** 10n : 200n * 10n ** 10n);
    return new Response(JSON.stringify({ prices }), { status: 200 });
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
  readBalances: async () => ({ "0x91b81bfbe3a747230f0529aa28d8b2bc898e6d56": { balance: 12n * 10n ** 18n, allowance: 0n } }),
});
assert.match(report, /CIEL LIVE TRADING/);
assert.match(report, /Starter balance: 12.0000 LVMON \(on-chain wallet balance\)/);
assert.match(report, /Available balance: 12.0000 LVMON/);
assert.match(report, /Margin reserved in open trades: 2.0000 LVMON/);
assert.ok(report.includes("Realised P&L: +1.0000 LVMON"));
assert.ok(report.includes("Trades: 1 open | 2 closed | 1 wins | 1 losses"));
assert.match(report, /RECENT LIVE ENTRY ATTEMPTS/);
assert.match(report, /XRP: FAILED — no position opened — insufficient transfers/);
assert.match(report, /BTC: AWAITING FINAL RECONCILIATION/);
assert.ok(report.includes("Unrealised P&L: +5.0000 LVMON"));
assert.ok(report.includes("LONG BTC/USD | entry $190.000000 | mark $200.000000 | unrealised +5.0000 LVMON"));
assert.ok(report.includes("unrealised P&L is gross before close fees and accrued carry"));
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
assert.ok(degraded.includes("Realised P&L: +1.0000 LVMON"));
assert.match(degraded, /UNAVAILABLE — oracle temporarily unavailable/);
assert.match(degraded, /open count unavailable/);
console.log("PASS: a mark/oracle outage does not erase realized P&L or report a false zero.");

