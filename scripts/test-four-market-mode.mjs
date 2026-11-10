import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isTemporaryMarketAllowed, restrictTemporaryMarketUniverse, TEMPORARY_MARKET_ALLOWLIST } from "../src/market-universe.js";
import { prepareLeverUpAdvisorPlan } from "../src/leverup-advisor.js";

assert.deepEqual(TEMPORARY_MARKET_ALLOWLIST, ["BTC", "ETH", "SOL", "BNB"]);
assert.deepEqual(
  restrictTemporaryMarketUniverse(["BTC", "XRP", "eth", "SOL", "BNB", "HYPE", "BTC"]),
  ["BTC", "ETH", "SOL", "BNB"],
);
for (const symbol of ["BTC", "ETH", "SOL", "BNB"]) assert.equal(isTemporaryMarketAllowed(symbol), true);
for (const symbol of ["XRP", "HYPE", "MON", "DOGE", ""]) assert.equal(isTemporaryMarketAllowed(symbol), false);

const blocked = await prepareLeverUpAdvisorPlan({
  env: {},
  candidate: { symbol: "XRP", side: "LONG" },
  reviewed: { verdict: "APPROVE" },
  signalId: "TEMP-ALLOWLIST-TEST",
  now: 1_800_000_000_000,
});
assert.equal(blocked.status, "BLOCKED_TEMPORARY_MARKET_UNIVERSE");

const native = await readFile("src/leverup-native-feed.js", "utf8");
assert.ok(native.includes("restrictTemporaryMarketUniverse(watchValues.map(upper))"));
const worker = await readFile("reconstructed/patched-worker.js", "utf8");
assert.ok(worker.includes("restrictTemporaryMarketUniverse([...new Set(parsed)])"));
assert.ok(worker.includes("Temporarily restricted market universe"));
assert.ok(worker.includes("rows.results = (rows.results || []).filter((position) => isTemporaryMarketAllowed(position.symbol))"));
assert.ok(worker.includes("isTemporaryMarketAllowed(p.symbol)"));
assert.ok(worker.includes("outside the temporary four-market universe"));
assert.ok(worker.includes('new Set(["BTC", "ETH", "MON", "SOL", "BNB"])'));

console.log("PASS: temporary allowlist covers advisor scans, paper entries, native LeverUp sampling and manual/live LeverUp preflight.");
