import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const NL = String.fromCharCode(10);
const file = path.join(process.cwd(), "reconstructed", "patched-worker.js");
let source = await readFile(file, "utf8");
const resetHandler = "async function handlePaperResetCommand(env, command) {\n  if (command !== \"/paperreset\") return false;\n  try {\n    const response = await feedStub(env).fetch(\"https://feed/paper/reset\", { method: \"POST\" });\n    const result = await response.json().catch(() => ({}));\n    if (!response.ok || result.ok !== true) throw new Error(result.detail || result.error || \"Paper reset returned HTTP \" + response.status);\n    await sendTelegram(env, [\n      \"🧪 PAPER ACCOUNT RESET COMPLETE\",\n      \"Starting balance: \" + Number(result.startingBalanceMon || 100).toFixed(3) + \" MON\",\n      \"Available balance: \" + Number(result.availableBalanceMon || 100).toFixed(3) + \" MON\",\n      \"Open paper positions closed: \" + Number(result.openPositionsClosed || 0),\n      \"Closed-trade history retained: \" + Number(result.historicalClosedTradesPreserved || 0),\n      \"New account realized P&L: 0.000 MON\",\n      \"New account win/loss counters: 0\",\n      \"Live trading settings and live positions: untouched\"\n    ].join(\"\\n\"));\n  } catch (error) {\n    await sendTelegram(env, \"⚠️ Paper reset failed. The account reset was not confirmed. \" + String(error).slice(0, 220));\n  }\n  return true;\n}\n__name(handlePaperResetCommand, \"handlePaperResetCommand\");\n";
const commandAnchor = "async function handleCommand(env, text) {";
const commandStart = source.indexOf(commandAnchor);
if (commandStart < 0 || source.indexOf(commandAnchor, commandStart + 1) >= 0) throw new Error("Paper reset command anchor mismatch");
if (!source.includes("if (await handlePaperResetCommand(env, command)) return;")) {
  source = source.slice(0, commandStart) + resetHandler + source.slice(commandStart);
  const commandLineStart = source.indexOf("  const command =", commandStart + resetHandler.length);
  const commandLineEnd = source.indexOf(NL, commandLineStart);
  if (commandLineStart < 0 || commandLineEnd < 0) throw new Error("Paper reset dispatch anchor mismatch");
  source = source.slice(0, commandLineEnd) + NL +
    "  if (await handlePaperResetCommand(env, command)) return;" + source.slice(commandLineEnd);
}
if (!source.includes('"/paperreset')) {
  const testAnchor = String.fromCharCode(32,32,32,32,32,32,34) + "/test " + String.fromCharCode(92) + "u2014 verify Telegram delivery" + String.fromCharCode(34) + ",";
  if (!source.includes(testAnchor)) throw new Error("Paper reset help anchor mismatch");
  source = source.replace(testAnchor, '      "/paperreset — reset paper account to 100 MON; preserve closed history",' + NL + testAnchor);
}
const oldReset = "          const closedTrades = Array.isArray(previous?.trades) ? previous.trades.filter((trade) => trade?.status === \"CLOSED\") : [];\n          const now = Date.now();\n          const state = freshPaperState(now);\n          state.trades = closedTrades.slice(0, 1000);\n          state.closedCount = 0;";
const newReset = "          const previousTrades = Array.isArray(previous?.trades) ? previous.trades : [];\n          const closedTrades = previousTrades.filter((trade) => trade?.status === \"CLOSED\");\n          const openTrades = previousTrades.filter((trade) => trade?.status === \"OPEN\");\n          const now = Date.now();\n          const resetClosedTrades = openTrades.map((trade) => ({\n            ...trade,\n            status: \"CLOSED\",\n            exitPrice: Number(trade.entryPrice) || null,\n            exitMonUsd: Number(trade.entryMonUsd) || null,\n            closedAtMs: now,\n            closeReason: \"ACCOUNT_RESET\",\n            resetClosed: true,\n            grossPnlMon: 0,\n            grossPnlUsd: 0,\n            returnOnMarginPct: 0\n          }));\n          const state = freshPaperState(now);\n          state.trades = [...resetClosedTrades, ...closedTrades].slice(0, 1000);\n          state.closedCount = 0;";
if (!source.includes(oldReset)) throw new Error("Durable Object reset implementation anchor mismatch");
source = source.replace(oldReset, newReset);
const oldResult = "openPositionsClosed: Array.isArray(previous?.trades) ? previous.trades.filter((trade) => trade?.status === \"OPEN\").length : 0, historicalClosedTradesPreserved: closedTrades.length";
if (!source.includes(oldResult)) throw new Error("Durable Object reset result anchor mismatch");
source = source.replace(oldResult, "openPositionsClosed: openTrades.length, historicalClosedTradesPreserved: closedTrades.length, resetClosedTradesRecorded: resetClosedTrades.length");
const oldSummary = "  const closedTrades = (state.trades || []).filter((trade) => trade.status === \"CLOSED\");";
const newSummary = "  const allClosedTrades = (state.trades || []).filter((trade) => trade.status === \"CLOSED\");" + NL +
  "  const resetAtMs = Number(state.resetAtMs) || 0;" + NL +
  "  const closedTrades = allClosedTrades.filter((trade) => !trade.resetClosed && (!resetAtMs || Number(trade.closedAtMs || 0) >= resetAtMs));";
if (!source.includes(oldSummary)) throw new Error("Paper summary session-counter anchor mismatch");
source = source.replace(oldSummary, newSummary);
const routeStart = source.indexOf('    if (url.pathname === "/internal/paper-reset"');
if (routeStart >= 0) {
  const routeEnd = source.indexOf('    if (url.pathname === "/telegram/webhook")', routeStart);
  if (routeEnd < 0) throw new Error("Could not locate obsolete D1 reset route end");
  source = source.slice(0, routeStart) + source.slice(routeEnd);
}
const scheduledStart = source.indexOf('        const authorization = await env.DB.prepare("SELECT token_hash FROM paper_reset_authorizations');
if (scheduledStart >= 0) {
  const logAt = source.indexOf('          console.log("CIEL paper account reset completed: " + JSON.stringify(resetResult));', scheduledStart);
  const blockEnd = logAt >= 0 ? source.indexOf(NL + "        }" + NL, logAt) : -1;
  if (logAt < 0 || blockEnd < 0) throw new Error("Could not locate obsolete scheduled D1 reset block end");
  source = source.slice(0, scheduledStart) + source.slice(blockEnd + (NL + "        }" + NL).length);
}
if (source.includes("SELECT token_hash FROM paper_reset_authorizations") || source.includes('url.pathname === "/internal/paper-reset"')) {
  throw new Error("Obsolete D1 paper-reset path remains in Worker");
}
await writeFile(file, source);
console.log("Added Telegram /paperreset, closed open paper trades in Durable Object history, and removed D1 reset polling.");
