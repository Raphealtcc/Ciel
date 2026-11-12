import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const source = await readFile("reconstructed/patched-worker.js", "utf8");
assert.match(source, /function getPaperSummary\(storage, prices, now, lastTickAt, includeHistory = false\)/);
assert.match(source, /closedTrades\.slice\(0, includeHistory \? 250 : 5\)/);
assert.match(source, /searchParams\.get\("history"\) === "1"/);
assert.match(source, /"https:\/\/feed\/paper\/profits" \+ \(includeHistory \? "\?history=1" : ""\)/);
console.log("Paper history diagnostics tests passed.");
