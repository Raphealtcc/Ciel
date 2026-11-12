import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

const source = await readFile("reconstructed/patched-worker.js", "utf8");
assert.match(source, /function getPaperSummary\(storage, prices, now, lastTickAt, includeHistory = false\)/);
assert.match(source, /const historyTrades = includeHistory/);
assert.match(source, /bestFavorableMovePct/);
assert.match(source, /byCloseReason: group\("closeReason"\)/);
assert.match(source, /if \(path === "\/paper\/history"\)/);
assert.match(source, /if \(url\.pathname === "\/api\/paper\/history"\)/);
assert.match(source, /getPaperSummary\(this\.state\.storage, this\.latest, Date\.now\(\), this\.lastTickAt, true\)/);
console.log("Paper history diagnostics tests passed.");
