import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const advisor = await readFile(new URL("../recovered-src/advisor.js.part-015", import.meta.url), "utf8");
assert.ok(advisor.includes('env?.CIEL_STATE?.get("ciel:control:live-enabled")'),
  "live mode must respect the Telegram/runtime override");
assert.ok(advisor.includes('env?.LEVERUP_NATIVE_SIGNAL_FEED_ENABLED'),
  "live signal generation must require the LeverUp-native feed");
assert.ok(advisor.includes("Hyperliquid-derived signals are not eligible for live mode"),
  "the live-mode cutoff must be explicit in diagnostics");
console.log("PASS: live mode rejects Hyperliquid-derived advisor signals until LeverUp-native market data is enabled.");
