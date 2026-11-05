import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source=await readFile("reconstructed/patched-worker.js","utf8");
const live=await readFile("src/leverup-advisor.js","utf8");
assert.ok(source.includes('const paperOverride = await readTradingControl(env, "ciel:control:paper-enabled", null);'));
assert.ok(source.includes('const paperTradingEnabled = String(paperOverride ?? env?.PAPER_TRADING_ENABLED ?? "false").toLowerCase() === "true";'));
assert.ok(source.includes("if (paperTradingEnabled && sizingLimits.feasible)"));
assert.ok(source.includes("PAPER TRADING PAUSED"));
assert.ok(source.includes("paperState?.trades || []"));
assert.ok(source.includes('paperStorage.put("ciel:adaptive-learning:v1"'));
assert.ok(source.includes("PAPER_MARKET_TIER_UNSUPPORTED"));
assert.ok(!source.includes('reason:"PAPER_MARKET_TIER_UNSUPPORTED"}); continue;'));
assert.ok(!source.includes('reason:"PAPER_INSUFFICIENT_FREE_MARGIN",requiredPaperMargin,availablePaperMargin:paperCash}); continue;'));
assert.ok(!source.includes('reason:"PAPER_POSITION_ALREADY_OPEN"}); continue;'));
// Live sizing must use the independently calculated USD allocation converted
// with the fresh MON/USD quote, not the paper margin or the retired MON env var.
assert.ok(live.includes("const usdLimits = leverUpUsdLimitsToMon({ env, monUsdPrice });"));
assert.ok(live.includes("const { totalAllocationMon, reserveMon, maxTradeMarginMon } = usdLimits;"));
assert.ok(live.includes("Number(reviewed?.liveMarginMon ?? maxTradeMarginMon)"));
assert.ok(!live.includes("Number(reviewed?.paperMarginMon)"));
assert.ok(!live.includes("env?.LEVERUP_MAX_TRADE_MARGIN_MON"));
assert.ok(source.includes("paper_trading_enabled: paperTradingEnabled"));
console.log("PASS: paper pause, independent live candidate discovery, fresh-quote USD allocation sizing, and preserved adaptive history.");
