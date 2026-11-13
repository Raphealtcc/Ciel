import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const file = path.join(process.cwd(), "reconstructed", "patched-worker.js");
let source = await readFile(file, "utf8");

const resetHandler = `async function handlePaperResetCommand(env, command) {
  if (command !== "/paperreset") return false;
  try {
    const response = await feedStub(env).fetch("https://feed/paper/reset", { method: "POST" });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true) throw new Error(result.detail || result.error || "Paper reset returned HTTP " + response.status);
    await sendTelegram(env, [
      "🧪 PAPER ACCOUNT RESET COMPLETE",
      "Starting balance: " + Number(result.startingBalanceMon || 100).toFixed(3) + " MON",
      "Available balance: " + Number(result.availableBalanceMon || 100).toFixed(3) + " MON",
      "Open paper positions closed: " + Number(result.openPositionsClosed || 0),
      "Closed-trade history retained: " + Number(result.historicalClosedTradesPreserved || 0),
      "New account realized P&L: 0.000 MON",
      "New account win/loss counters: 0",
      "Live trading settings and live positions: untouched"
    ].join("\n"));
  } catch (error) {
    await sendTelegram(env, "⚠️ Paper reset failed. The account reset was not confirmed. " + String(error).slice(0, 220));
  }
  return true;
}
__name(handlePaperResetCommand, "handlePaperResetCommand");
`;

const commandAnchor = "async function handleCommand(env, text) {";
const commandStart = source.indexOf(commandAnchor);
if (commandStart < 0 || source.indexOf(commandAnchor, commandStart + 1) >= 0) throw new Error("Paper reset command anchor mismatch");
if (!source.includes("if (await handlePaperResetCommand(env, command)) return;")) {
  source = source.slice(0, commandStart) + resetHandler + source.slice(commandStart);
  const dispatchStart = source.indexOf("  if (await handleAdvisorCommand(env, text)) return;", commandStart + resetHandler.length);
  const commandLineStart = source.indexOf("  const command =", dispatchStart);
  const commandLineEnd = source.indexOf("\n", commandLineStart);
  if (dispatchStart < 0 || commandLineStart < 0 || commandLineEnd < 0) throw new Error("Paper reset dispatch anchor mismatch");
  const commandLine = source.slice(commandLineStart, commandLineEnd);
  source = source.slice(0, dispatchStart) + commandLine + "\n  if (await handlePaperResetCommand(env, command)) return;\n  if (await handleAdvisorCommand(env, text)) return;" + source.slice(commandLineEnd);
}
if (!source.includes('"/paperreset')) {
  const testAnchor = '      "/test \\u2014 verify Telegram delivery",';
  if (!source.includes(testAnchor)) throw new Error("Paper reset help anchor mismatch");
  source = source.replace(testAnchor, '      "/paperreset — reset paper account to 100 MON; preserve closed history",\n' + testAnchor);
}

const oldReset = `          const closedTrades = Array.isArray(previous?.trades) ? previous.trades.filter((trade) => trade?.status === "CLOSED") : [];
          const now = Date.now();
          const state = freshPaperState(now);
          state.trades = closedTrades.slice(0, 1000);
          state.closedCount = 0;`;
const newReset = `          const previousTrades = Array.isArray(previous?.trades) ? previous.trades : [];
          const closedTrades = previousTrades.filter((trade) => trade?.status === "CLOSED");
          const openTrades = previousTrades.filter((trade) => trade?.status === "OPEN");
          const now = Date.now();
          const resetClosedTrades = openTrades.map((trade) => ({
            ...trade,
            status: "CLOSED",
            exitPrice: Number(trade.entryPrice) || null,
            exitMonUsd: Number(trade.entryMonUsd) || null,
            closedAtMs: now,
            closeReason: "ACCOUNT_RESET",
            resetClosed: true,
            grossPnlMon: 0,
            grossPnlUsd: 0,
            returnOnMarginPct: 0
          }));
          const state = freshPaperState(now);
          state.trades = [...resetClosedTrades, ...closedTrades].slice(0, 1000);
          state.closedCount = 0;`;
if (!source.includes(oldReset)) throw new Error("Durable Object reset implementation anchor mismatch");
source = source.replace(oldReset, newReset);
const oldResult = 'openPositionsClosed: Array.isArray(previous?.trades) ? previous.trades.filter((trade) => trade?.status === "OPEN").length : 0, historicalClosedTradesPreserved: closedTrades.length';
if (!source.includes(oldResult)) throw new Error("Durable Object reset result anchor mismatch");
source = source.replace(oldResult, "openPositionsClosed: openTrades.length, historicalClosedTradesPreserved: closedTrades.length, resetClosedTradesRecorded: resetClosedTrades.length");

const routeStart = source.indexOf('    if (url.pathname === "/internal/paper-reset"');
if (routeStart >= 0) {
  const routeEnd = source.indexOf('    if (url.pathname === "/telegram/webhook")', routeStart);
  if (routeEnd < 0) throw new Error("Could not locate obsolete D1 reset route end");
  source = source.slice(0, routeStart) + source.slice(routeEnd);
}
const scheduledStart = source.indexOf('        const authorization = await env.DB.prepare("SELECT token_hash FROM paper_reset_authorizations');
if (scheduledStart >= 0) {
  const logAt = source.indexOf('          console.log("CIEL paper account reset completed: " + JSON.stringify(resetResult));', scheduledStart);
  const blockEnd = logAt >= 0 ? source.indexOf("\n        }\n", logAt) : -1;
  if (logAt < 0 || blockEnd < 0) throw new Error("Could not locate obsolete scheduled D1 reset block end");
  source = source.slice(0, scheduledStart) + source.slice(blockEnd + "\n        }\n".length);
}
if (source.includes("SELECT token_hash FROM paper_reset_authorizations") || source.includes('url.pathname === "/internal/paper-reset"')) {
  throw new Error("Obsolete D1 paper-reset path remains in Worker");
}
await writeFile(file, source);
console.log("Added Telegram /paperreset, closed open paper trades in Durable Object history, and removed D1 reset polling.");
