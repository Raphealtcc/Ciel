import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile("reconstructed/patched-worker.js", "utf8");
const isolation = await readFile("scripts/apply-paper-live-isolation.mjs", "utf8");
const advisor = await readFile("src/leverup-advisor.js", "utf8");
const coordinator = await readFile("src/leverup-coordinator.js", "utf8");

for (const command of ["/paperactive", "/paperdeactivate", "/liveactive", "/livedeactivate", "/modes", "/geministatus"]) {
  assert.ok(worker.includes(command), "missing Telegram command " + command);
}
assert.ok(worker.includes("ciel:control:paper-enabled"));
assert.ok(worker.includes("ciel:control:live-enabled"));
assert.ok(worker.includes("ciel:control:live-entry-enabled"));
assert.ok(worker.includes('writeTradingControls(env, [[keys.live, true], [keys.entries, true]])'));
assert.equal((worker.match(/from "\.\.\/src\/trading-controls\.js";/g) || []).length, 1, "the bundled Worker must import the D1 controls module only once");
for (const key of ["paper-enabled", "live-enabled", "live-entry-enabled"]) {
  assert.ok(worker.includes('readTradingControl(env, "ciel:control:' + key + '", ' + (key === "live-entry-enabled" ? '"false"' : "null") + ')'), "Telegram status/runtime must read " + key + " from D1");
  assert.ok(!worker.includes('CIEL_STATE?.get("ciel:control:' + key + '")'), "KV must not remain a trading-control source for " + key);
}
assert.ok(isolation.includes("readTradingControl(env"));
assert.ok(isolation.includes('await readTradingControl(env, "ciel:control:paper-enabled", null)'));
assert.ok(advisor.includes('readTradingControl(env, "ciel:control:live-enabled", null)'));
assert.ok(advisor.includes('readTradingControl(env, "ciel:control:live-entry-enabled", "false")'),
  "live entries must fail closed when the D1 entry flag is missing");
assert.ok(advisor.includes('liveEntryOverride === "true"'),
  "advisor must require an explicit D1 live-entry enable before preparing live execution");
assert.ok(!advisor.includes('env?.CIEL_STATE?.get("ciel:control:live-entry-enabled")'),
  "advisor must not read the live-entry control from KV");
assert.ok(coordinator.includes('readTradingControl(env, "ciel:control:live-enabled", null)'));
assert.ok(coordinator.includes('readTradingControl(env, "ciel:control:live-entry-enabled", "false")'));
assert.ok(!coordinator.includes('env?.CIEL_STATE?.get("ciel:control:live-entry-enabled")'));
assert.ok(coordinator.includes("BLOCKED_POSITION_DISCOVERY"));
assert.ok(worker.includes('ciel:leverup:gemini-review:last'));
assert.ok(worker.includes("handlePaperBalanceCommand"));\nassert.ok(worker.includes("Fee model: estimated 3 bps per side deducted"));
assert.ok(worker.includes("/paperbalance"));
assert.ok(worker.includes('ciel:leverup:position-manager:last-run'));
assert.ok(worker.includes('Configured API keys: '));
assert.ok(worker.includes("getGeminiApiKeys(env)"), "Gemini status must count numbered and shared API key secrets");
assert.ok(worker.includes("const geminiKeyCount = getGeminiApiKeys(env).length;"), "diagnostics must count the same Gemini key sources");
assert.ok(worker.includes("function getGeminiApiKeys(env = {})"), "Worker must expose shared/numbered Gemini key discovery");
assert.ok(worker.includes('env["GEMINI_API_KEY_" + index]'));
assert.ok(worker.includes("JSON.parse(raw)"), "Gemini key parser must accept JSON-array and CSV secret formats");
assert.ok(worker.includes("async function review(env, s, forecast, market, intraday, eventIntel = null, candleStructure = null, sizing = null) {\n  const keys = getGeminiApiKeys(env);"), "signal reviews must discover numbered Gemini secrets");
assert.ok(worker.includes("async function reviewMarketEvent(env, bundle) {\n  const keys=getGeminiApiKeys(env);"), "market-event reviews must discover numbered Gemini secrets");
assert.ok(worker.includes('Last result: '));
assert.ok(worker.includes("Recent actual Gemini decisions"));
assert.ok(worker.includes("Paper positions are not currently sent to Gemini"));
assert.ok(worker.includes("No live LeverUp positions were found on the latest manager scan"));
assert.ok(worker.includes("Live positions were detected, but the symbol list is unavailable"));
assert.ok(worker.includes('import { readTradingControl, writeTradingControls } from "../src/trading-controls.js"'));
assert.ok(worker.includes("ciel:leverup:gemini-review:history:v1"));
assert.ok(worker.includes("feed/paper/profits"));
assert.ok(worker.includes("This command will not bypass it"));
assert.ok(!worker.includes("LeverUp-native feed is not READY or its latest sample is stale"), "live activation must not depend on LeverUp-native market feed readiness");
assert.ok(!worker.includes("recent read-only LeverUp market and coordinator diagnostics have not passed"), "live activation must not require read-only LeverUp market/coordinator diagnostics");
assert.ok(worker.includes("position manager is stale or blocked"));
console.log("PASS: independent Telegram mode controls and multi-signal live activation safety gates.");
