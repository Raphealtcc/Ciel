import assert from "node:assert/strict";import{readFile}from"node:fs/promises";
const w=await readFile("reconstructed/patched-worker.js","utf8"),p=await readFile("scripts/apply-paper-live-isolation.mjs","utf8"),a=await readFile("src/leverup-advisor.js","utf8"),c=await readFile("src/leverup-coordinator.js","utf8");
for(const x of ["/paperactive","/paperdeactivate","/liveactive","/livedeactivate","/modes"])assert.ok(w.includes(x));
assert.ok(w.includes("ciel:control:paper-enabled")&&w.includes("ciel:control:live-enabled")&&w.includes("ciel:control:live-entry-enabled"));
assert.ok(p.includes('await env?.CIEL_STATE?.get("ciel:control:paper-enabled")'));
assert.ok(a.includes('env.CIEL_STATE.get("ciel:control:live-enabled")')&&a.includes('liveEntryOverride !== "false"'));
assert.ok(c.includes('entryOverride === "false"')&&c.includes('if (liveOverride != null) env = { ...env, LEVERUP_LIVE_TRADING: liveOverride };'));
assert.ok(w.includes("This command will not bypass it"));console.log("PASS: independent Telegram mode controls, hard kill-switch and retained live position management.");