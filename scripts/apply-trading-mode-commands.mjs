import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const file = path.join(process.cwd(), "reconstructed", "patched-worker.js");
let source = await readFile(file, "utf8");
const importLine = 'import { readTradingControl, writeTradingControls } from "../src/trading-controls.js";';
const writeOnlyImport = 'import { writeTradingControls } from "../src/trading-controls.js";';
const readOnlyImport = 'import { readTradingControl } from "../src/trading-controls.js";';
if (source.includes(writeOnlyImport)) source = source.replace(writeOnlyImport, importLine);
else if (source.includes(readOnlyImport)) source = source.replace(readOnlyImport, importLine);
else if (!source.includes(importLine)) source = importLine + "\n" + source;

const geminiStatusHelper = `async function handleGeminiStatusCommand(env, command) {
  if (command !== "/geministatus") return false;
  const keys = [...new Set(String(env.GEMINI_API_KEYS || "").split(/[,;\\n]+/).map((key) => key.trim()).filter(Boolean))];
  const safeGet = async (key, type) => { try { return await env?.CIEL_STATE?.get(key, type); } catch { return null; } };
  const [lastReview, manager, historyRaw, liveOverride, entryOverride, paper] = await Promise.all([
    safeGet("ciel:leverup:gemini-review:last", "json"),
    safeGet("ciel:leverup:position-manager:last-run", "json"),
    safeGet("ciel:leverup:gemini-review:history:v1", "json"),
    readTradingControl(env, "ciel:control:live-enabled", null).catch(() => null),
    readTradingControl(env, "ciel:control:live-entry-enabled", "false").catch(() => "false"),
    feedStub2(env).fetch("https://feed/paper/profits").then((response) => response.json()).catch(() => null)
  ]);
  const history = Array.isArray(historyRaw) ? historyRaw : (typeof historyRaw === "string" ? (() => { try { return JSON.parse(historyRaw); } catch { return []; } })() : []);
  const actualReviews = history.filter((review) => review && String(review.status || "").toUpperCase() !== "COOLDOWN");
  const latestReview = actualReviews[0] || lastReview || null;
  const time = (value) => Number(value) > 0 ? new Date(Number(value)).toISOString().replace("T", " ").replace(".000Z", " UTC") : "not recorded";
  const age = (value) => Number(value) > 0 ? Math.max(0, Math.round((Date.now() - Number(value)) / 60000)) + " min ago" : "unknown";
  const managerAge = Number(manager?.at) > 0 ? Date.now() - Number(manager.at) : Infinity;
  const liveMaster = String(liveOverride ?? env.LEVERUP_LIVE_TRADING ?? "false").toLowerCase() === "true";
  const entryEnabled = String(entryOverride ?? "false").toLowerCase() === "true";
  const killSwitchOn = String(env.LEVERUP_KILL_SWITCH ?? "true").toLowerCase() !== "false";
  const managerActive = liveMaster && !killSwitchOn, liveEntriesActive = managerActive && entryEnabled;
  const livePositions = Array.isArray(manager?.positions) ? manager.positions : [];
  const paperOpen = Array.isArray(paper?.openTrades) ? paper.openTrades : [];
  const statusCounts = manager?.aiReviewStatusCounts && typeof manager.aiReviewStatusCounts === "object" ? Object.entries(manager.aiReviewStatusCounts).map(([key,value]) => key + "=" + value).join(", ") : "not recorded";
  const recentLines = actualReviews.slice(0, 3).map((review) => time(review.at) + " â " + String(review.symbol || "UNKNOWN") + " " + String(review.side || "") + " â " + String(review.action || "HOLD") + " (" + String(review.confidence || 0) + "/100): " + String(review.reason || review.status || "").slice(0, 150));
  const livePositionText = livePositions.length ? livePositions.map((position) => String(position.symbol || "UNKNOWN") + " " + String(position.side || "UNKNOWN") + " [" + String(position.positionHash || "").slice(0, 10) + "]").join(", ") : (Number(manager?.openPositionCount) > 0 ? "Live positions were detected, but the symbol list is unavailable in the saved manager snapshot." : "No live LeverUp positions were found on the latest manager scan.");
  const paperText = paperOpen.length ? paperOpen.map((position) => String(position.symbol || "UNKNOWN") + " " + String(position.side || "UNKNOWN") + (Number.isFinite(Number(position.unrealizedPnlMon)) ? " (uPnL " + Number(position.unrealizedPnlMon).toFixed(3) + " MON)" : "")).join(", ") : "none open";
  const lines = [
    "GEMINI POSITION MANAGER STATUS",
    "Model: " + String(env.GEMINI_MODEL || "gemini-2.5-flash"),
    "Configured API keys: " + keys.length + " (values hidden)",
    "New live entries: " + (liveEntriesActive ? "ON" : "OFF"),
    "Existing live-position manager: " + (managerActive ? "ACTIVE â monitors existing positions" : "READ-ONLY / DISABLED"),
    "Manager heartbeat: " + (managerAge <= 2 * 60 * 1000 ? "FRESH" : (Number.isFinite(managerAge) ? "STALE" : "NOT RECORDED")) + " (" + age(manager?.at) + ")",
    "Last scan: " + String(manager?.status || "NOT RECORDED") + " | checked " + String(manager?.checked ?? "unknown") + " | open live positions " + String(manager?.openPositionCount ?? "unknown") + " | Gemini reviews " + String(manager?.aiReviewed ?? "unknown"),
    "Live positions: " + livePositionText,
    "Review status counts: " + statusCounts,
    "Last result: " + String(latestReview?.status || "NO ACTUAL REVIEW RECORDED") + " (" + age(latestReview?.at) + ")",
    latestReview ? "Last actual Gemini decision: " + String(latestReview.symbol || "UNKNOWN") + " " + String(latestReview.side || "") + " â " + String(latestReview.action || "HOLD") + " (" + String(latestReview.confidence || 0) + "/100), " + time(latestReview.at) : "",
    latestReview?.reason ? "Gemini reasoning: " + String(latestReview.reason).slice(0, 220) : "",
    recentLines.length ? "Recent actual Gemini decisions:\\n" + recentLines.join("\\n") : "No actual Gemini position reviews have been saved yet.",
    "Paper open positions: " + paperText,
    "Paper positions are not currently sent to Gemini; the paper engine manages TP/SL and profit protection separately."
  ].filter(Boolean);
  await sendTelegram(env, lines.join("\\n"));
  return true;
}
__name(handleGeminiStatusCommand, "handleGeminiStatusCommand");
`;;
const helper = `async function handleTradingModeCommand(env, command) {
  const keys = {
    paper: "ciel:control:paper-enabled",
    live: "ciel:control:live-enabled",
    entries: "ciel:control:live-entry-enabled"
  };
  const read = async (key, fallback) => readTradingControl(env, key, fallback);
  if (command === "/modes") {
    const [paper, live, entries] = await Promise.all([
      read(keys.paper, String(env.PAPER_TRADING_ENABLED || "false").toLowerCase()),
      read(keys.live, String(env.LEVERUP_LIVE_TRADING || "false").toLowerCase()),
      read(keys.entries, "false")
    ]);
    const killSwitch = String(env.LEVERUP_KILL_SWITCH).toLowerCase() !== "false";
    const liveConfigured = String(live).toLowerCase() === "true";
    const liveManagement = liveConfigured && !killSwitch;
    const liveEntries = liveManagement && String(entries).toLowerCase() === "true";
    await sendTelegram(env, [
      "CIEL TRADING MODES",
      "Paper entries: " + (String(paper).toLowerCase() === "true" ? "ACTIVE" : "INACTIVE"),
      "Live entries: " + (liveEntries ? "ACTIVE" : "INACTIVE"),
      "Live position management: " + (liveManagement ? "ENABLED" : "READ-ONLY"),
      "Kill switch: " + (killSwitch ? "ON" : "OFF")
    ].join("\\n"));
    return true;
  }
  if (command === "/paperactive" || command === "/paperdeactivate") {
    const on = command === "/paperactive";
    await writeTradingControls(env, [[keys.paper, on]]);
    await sendTelegram(env, on
      ? "Paper trading activated. New paper entries enabled; live unchanged."
      : "Paper trading deactivated. No new paper entries; existing paper positions and history are retained. Live unchanged.");
    return true;
  }
  if (command === "/livedeactivate") {
    await writeTradingControls(env, [[keys.entries, false]]);
    await sendTelegram(env, "New live entries deactivated. Existing live positions remain under close/exit management; no positions were closed. Emergency kill switch remains independent.");
    return true;
  }
  if (command === "/liveactive") {
    const manager = await env.CIEL_STATE.get("ciel:leverup:position-manager:last-run", "json").catch(() => null);
    if (!manager || Date.now() - Number(manager.at || 0) > 120000 || String(manager.status || "").startsWith("BLOCKED") || manager.status === "FAILED") {
      await sendTelegram(env, "Live activation refused: LeverUp position manager is stale or blocked. Existing position safety must be verified first.");
      return true;
    }
    if (String(env.LEVERUP_LIVE_TRADING).toLowerCase() !== "true") {
      await sendTelegram(env, "Live activation refused: LEVERUP_LIVE_TRADING is not true in Cloudflare Worker settings.");
      return true;
    }
    if (String(env.LEVERUP_KILL_SWITCH).toLowerCase() !== "false") {
      await sendTelegram(env, "Live activation refused: LEVERUP_KILL_SWITCH is ON. Turn it OFF in Cloudflare only after confirming readiness. This command will not bypass it.");
      return true;
    }
    if (String(env.LEVERUP_PREFLIGHT_ENABLED).toLowerCase() !== "true" || !env.LEVERUP_TRADER_PRIVATE_KEY || !env.LEVERUP_AGENT_PRIVATE_KEY ||
        !/^0x[0-9a-fA-F]{40}$/.test(String(env.LEVERUP_TRADER_ADDRESS || "")) || !/^0x[0-9a-fA-F]{40}$/.test(String(env.LEVERUP_AGENT_ADDRESS || ""))) {
      await sendTelegram(env, "Live activation refused: LeverUp preflight, trader/agent keys, or wallet addresses are not fully configured.");
      return true;
    }
    await writeTradingControls(env, [[keys.live, true], [keys.entries, true]]);
    await sendTelegram(env, "Live entries activated in D1. Each candidate must still pass fresh preflight, allowance, balance, venue and portfolio-risk checks. Use /livedeactivate to stop new entries.");
    return true;
  }
  return false;
}
__name(handleTradingModeCommand, "handleTradingModeCommand");
`;
const anchor = "async function handleCommand(env, text) {";
if (source.split(anchor).length !== 2) throw new Error("Trading-mode handler anchor mismatch");
function replaceNamedHandler(source, name, replacement, anchor) {
  const startMarker = "async function " + name + "(";
  const endMarker = '__name(' + name + ', "' + name + '");';
  const start = source.indexOf(startMarker);
  if (start < 0) return source.replace(anchor, replacement + anchor);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error("Existing " + name + " handler has no end marker");
  return source.slice(0, start) + replacement + source.slice(end + endMarker.length);
}
source = replaceNamedHandler(source, "handleGeminiStatusCommand", geminiStatusHelper, anchor);
source = replaceNamedHandler(source, "handleTradingModeCommand", helper, anchor);

const dispatch = '  if (await handleAdvisorCommand(env, text)) return;\n  const command = (text.trim().split(/\\s+/, 1)[0] || "").split("@")[0].toLowerCase();';
const dispatchReplacement = '  const command = (text.trim().split(/\\s+/, 1)[0] || "").split("@")[0].toLowerCase();\n  if (await handleGeminiStatusCommand(env, command)) return;\n  if (await handleTradingModeCommand(env, command)) return;\n  if (await handleAdvisorCommand(env, text)) return;';
if (source.includes(dispatch)) source = source.replace(dispatch, dispatchReplacement);
else if (!source.includes("if (await handleTradingModeCommand(env, command)) return;")) throw new Error("Telegram command dispatch anchor mismatch");

const helpAnchor = '      "/test Ã¢ÂÂ verify Telegram delivery",';
if (source.includes(helpAnchor)) source = source.replace(helpAnchor,
  '      "/paperactive /paperdeactivate Ã¢ÂÂ toggle paper entries",\n      "/liveactive /livedeactivate Ã¢ÂÂ toggle live entries",\n      "/modes Ã¢ÂÂ show effective trading modes",\n      "/geministatus Ã¢ÂÂ Gemini keys, latest review and manager health",\n' + helpAnchor);

await writeFile(file, source);
console.log("Applied D1-backed Telegram trading-mode controls.");
