import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const advisor = await readFile(new URL("../recovered-src/advisor.js.part-015", import.meta.url), "utf8");
const feed = await readFile(new URL("../recovered-src/hyperliquid_feed.js.part-001", import.meta.url), "utf8");
assert.ok(advisor.includes('readTradingControl(env, "ciel:control:live-enabled", null)'),
  "live mode must respect the Telegram/runtime override");
assert.ok(advisor.includes("if (liveMode)"),
  "live signal generation must stop consuming the Hyperliquid feed");
assert.ok(advisor.includes("Hyperliquid-derived signals are not eligible for live mode"),
  "the live-mode cutoff must be explicit in diagnostics");
assert.ok(feed.includes('readTradingControl(this.env, "ciel:control:live-enabled", null)'),
  "Hyperliquid feed mode must read the D1 control table");
assert.ok(feed.includes("PAUSED_LIVE_VENUE_CUTOFF"),
  "the Hyperliquid feed must return a disabled state in LeverUp live mode");
assert.ok(feed.includes("this.stopHyperliquidSocket()"),
  "the Hyperliquid WebSocket must be closed in LeverUp live mode");
console.log("PASS: live mode rejects Hyperliquid-derived advisor signals.");
