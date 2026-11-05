import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile("reconstructed/patched-worker.js", "utf8");
const isolation = await readFile("scripts/apply-paper-live-isolation.mjs", "utf8");
const advisor = await readFile("src/leverup-advisor.js", "utf8");
const coordinator = await readFile("src/leverup-coordinator.js", "utf8");

for (const command of ["/paperactive", "/paperdeactivate", "/liveactive", "/livedeactivate", "/modes"]) {
  assert.ok(worker.includes(command), "missing Telegram command " + command);
}
assert.ok(worker.includes("ciel:control:paper-enabled"));
assert.ok(worker.includes("ciel:control:live-enabled"));
assert.ok(worker.includes("ciel:control:live-entry-enabled"));
assert.ok(worker.includes("writeTradingControls(env, [[keys.live, true], [keys.entries, true]])"));
for (const key of ["paper-enabled", "live-enabled", "live-entry-enabled"]) {
  assert.ok(worker.includes('readTradingControl(env, "ciel:control:' + key + '", null)'), "Telegram status/runtime must read " + key + " from D1");
  assert.ok(!worker.includes('CIEL_STATE?.get("ciel:control:' + key + '")'), "KV must not remain a trading-control source for " + key);
});
assert.ok(isolation.includes("readTradingControl(env"));
assert.ok(isolation.includes('await readTradingControl(env, "ciel:control:paper-enabled", null)'));
assert.ok(advisor.includes('readTradingControl(env, "ciel:control:live-enabled", null)'));
assert.ok(advisor.includes('liveEntryOverride !== "false"'));
assert.ok(coordinator.includes('entryOverride === "false"'));
assert.ok(coordinator.includes("BLOCKED_POSITION_DISCOVERY"));
assert.ok(worker.includes("This command will not bypass it"));
assert.ok(worker.includes("LeverUp-native feed is not READY or its latest sample is stale"));
assert.ok(worker.includes("recent read-only LeverUp market and coordinator diagnostics have not passed"));
assert.ok(worker.includes("position manager is stale or blocked"));
console.log("PASS: independent Telegram mode controls and multi-signal live activation safety gates.");
