import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source = await readFile("reconstructed/patched-worker.js", "utf8");
for (const fragment of [
  'async function handlePaperResetCommand(env, command)',
  'command !== "/paperreset"',
  'feedStub(env).fetch("https://feed/paper/reset"',
  'if (await handlePaperResetCommand(env, command)) return;',
  'closeReason: "ACCOUNT_RESET"',
  'state.trades = [...resetClosedTrades, ...closedTrades].slice(0, 1000)',
  'resetClosedTradesRecorded: resetClosedTrades.length',
  'const allClosedTrades = (state.trades || []).filter((trade) => trade.status === "CLOSED")',
  'const closedTrades = allClosedTrades.filter((trade) => !trade.resetClosed'
]) assert.ok(source.includes(fragment), "Missing paper reset behavior: " + fragment);
assert.ok(!source.includes("SELECT token_hash FROM paper_reset_authorizations"), "D1 reset polling still exists");
assert.ok(!source.includes('url.pathname === "/internal/paper-reset"'), "D1 reset endpoint still exists");
console.log("Paper reset tests passed.");
