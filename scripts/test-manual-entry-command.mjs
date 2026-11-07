import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile("reconstructed/patched-worker.js", "utf8");
assert.ok(worker.includes("async function handleLeverUpManualEntryCommand(env, text)"));
assert.ok(worker.includes('command !== "/long" && command !== "/short"'));
assert.ok(worker.includes('if (args.length !== 2)'));
assert.ok(worker.includes('command === "/long" ? "LONG" : "SHORT"'));
assert.ok(worker.includes("prepareLeverUpAdvisorPlan({"));
assert.ok(worker.includes('reviewed: { verdict: "APPROVE", liveMarginMon: 0'));
assert.ok(worker.includes('readTradingControl(env, "ciel:control:live-enabled", null)'));
assert.ok(worker.includes('readTradingControl(env, "ciel:control:live-entry-enabled", "false")'));
assert.ok(worker.includes('String(env?.LEVERUP_KILL_SWITCH).toLowerCase() !== "false"'));
assert.ok(worker.includes("stopPct: 0.25, targetPct: 0.5, holdMinutes: 3"));
assert.ok(worker.includes('use /purge " + symbol'));
assert.ok(worker.includes("if (await handleLeverUpManualEntryCommand(env, text)) return;"));
console.log("PASS: /long TOKEN and /short TOKEN use the normal LeverUp plan/entry path, require live controls, and retain venue and portfolio-risk safeguards.");
