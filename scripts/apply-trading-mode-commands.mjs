import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const file = path.join(process.cwd(), "reconstructed", "patched-worker.js");
let source = await readFile(file, "utf8");
const importLine = 'import { writeTradingControls } from "../src/trading-controls.js";';
if (!source.includes(importLine)) source = importLine + "\n" + source;

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
    const nativeFeed = await env.CIEL_STATE.get("ciel:leverup:native-feed:latest", "json").catch(() => null);
    if (nativeFeed?.status !== "READY" || Date.now() - Number(nativeFeed?.sampledAt || 0) > 120000) {
      await sendTelegram(env, "Live activation refused: LeverUp-native feed is not READY or its latest sample is stale. New live entries remain disabled.");
      return true;
    }
    const diagnostics = await env.CIEL_STATE.get("ciel:leverup:diagnostics:v1", "json").catch(() => null);
    if (diagnostics?.status !== "READ_ONLY_CHECKS_PASS" || diagnostics?.coordinator?.status !== "PASS" || Date.now() - Number(diagnostics?.checkedAt || 0) > 10 * 60 * 1000) {
      await sendTelegram(env, "Live activation refused: recent read-only LeverUp market and coordinator diagnostics have not passed. New live entries remain disabled.");
      return true;
    }
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
if (!source.includes("async function handleTradingModeCommand(")) source = source.replace(anchor, helper + anchor);

const dispatch = '  if (await handleAdvisorCommand(env, text)) return;\n  const command = (text.trim().split(/\\s+/, 1)[0] || "").split("@")[0].toLowerCase();';
const dispatchReplacement = '  const command = (text.trim().split(/\\s+/, 1)[0] || "").split("@")[0].toLowerCase();\n  if (await handleTradingModeCommand(env, command)) return;\n  if (await handleAdvisorCommand(env, text)) return;';
if (source.includes(dispatch)) source = source.replace(dispatch, dispatchReplacement);
else if (!source.includes("if (await handleTradingModeCommand(env, command)) return;")) throw new Error("Telegram command dispatch anchor mismatch");

const helpAnchor = '      "/test — verify Telegram delivery",';
if (source.includes(helpAnchor)) source = source.replace(helpAnchor,
  '      "/paperactive /paperdeactivate — toggle paper entries",\n      "/liveactive /livedeactivate — toggle live entries",\n      "/modes — show effective trading modes",\n' + helpAnchor);

await writeFile(file, source);
console.log("Applied D1-backed Telegram trading-mode controls.");
