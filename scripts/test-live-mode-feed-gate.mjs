import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile("reconstructed/patched-worker.js", "utf8");
assert.ok(worker.includes('readTradingControl(env, "ciel:control:live-enabled", null)'),
  "advisor and scheduled handler must read live mode from D1");
assert.ok(worker.includes("Hyperliquid remains a read-only market-data source for the shared CIEL signal pipeline"));
assert.ok(worker.includes("async hyperliquidDisabledForLiveMode()") && worker.includes("return false;"),
  "Hyperliquid market data must remain available as a read-only signal source in LeverUp live mode");
assert.ok(!worker.includes('readTradingControl(this.env, "ciel:control:live-enabled", null)'),
  "the feed must not disable the shared read-only signal source based on live mode");
assert.ok(worker.includes('readTradingControl(env, "ciel:control:live-entry-enabled", "false")'),
  "live entries must remain disabled unless explicitly enabled in D1");
assert.ok(!worker.includes('CIEL_STATE?.get("ciel:control:live-enabled")'),
  "the deployed Worker must not retain a KV trading-mode reader");
console.log("PASS: bundled advisor, scheduled handler, feed and Telegram mode readers use D1.");
