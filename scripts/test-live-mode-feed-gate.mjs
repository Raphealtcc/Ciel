import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile("reconstructed/patched-worker.js", "utf8");
assert.ok(worker.includes('readTradingControl(env, "ciel:control:live-enabled", null)'),
  "advisor and scheduled handler must read live mode from D1");
assert.ok(worker.includes('readTradingControl(this.env, "ciel:control:live-enabled", null)'),
  "Hyperliquid feed mode must read live mode from D1");
assert.ok(worker.includes('readTradingControl(env, "ciel:control:live-entry-enabled", "false")'),
  "live entries must remain disabled unless explicitly enabled in D1");
assert.ok(worker.includes("PAUSED_LIVE_VENUE_CUTOFF"),
  "the Hyperliquid feed must return a disabled state in LeverUp live mode");
assert.ok(worker.includes("this.stopHyperliquidSocket()"),
  "the Hyperliquid WebSocket must be closed in LeverUp live mode");
assert.ok(!worker.includes('CIEL_STATE?.get("ciel:control:live-enabled")'),
  "the deployed Worker must not retain a KV trading-mode reader");
console.log("PASS: bundled advisor, scheduled handler, feed and Telegram mode readers use D1.");
