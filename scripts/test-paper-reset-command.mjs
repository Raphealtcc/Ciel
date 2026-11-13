import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile("reconstructed/patched-worker.js", "utf8");
assert.match(source, /async function handlePaperResetCommand\\(env, command\\)/);
assert.match(source, /command !== "\/paperreset"/);
assert.match(source, /feedStub\\(env\\)\\.fetch\\("https:\/\/feed\/paper\/reset"/);
assert.match(source, /if \\(await handlePaperResetCommand\\(env, command\\)\\) return;/);
assert.match(source, /closeReason: "ACCOUNT_RESET"/);
assert.match(source, /state\\.trades = \\[\\.\\.\\.resetClosedTrades, \\.\\.\\.closedTrades\\]/);
assert.match(source, /resetClosedTradesRecorded: resetClosedTrades\\.length/);
assert.doesNotMatch(source, /SELECT token_hash FROM paper_reset_authorizations/);
assert.doesNotMatch(source, /url\\.pathname === "\/internal\/paper-reset"/);
console.log("Paper reset tests passed: Telegram-only trigger, DO-only account state, reset closure/history retention, no D1 reset polling.");
