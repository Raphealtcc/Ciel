import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const file = path.join(process.cwd(), "reconstructed", "patched-worker.js");
let source = await readFile(file, "utf8");

function once(before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(label + ": expected exactly one match, found " + count);
  source = source.replace(before, after);
  console.log("Applied manual LeverUp test command: " + label);
}

const helper = `async function handleLeverUpManualEntryCommand(env, text) {
  const args = String(text || "").trim().split(/\\s+/).filter(Boolean);
  const command = (args[0] || "").split("@")[0].toLowerCase();
  if (command !== "/long" && command !== "/short") return false;
  if (args.length !== 2) {
    await sendTelegram(env, "Usage: " + command + " TOKEN\\nExample: " + command + " XRP\\nOne market per command; close the test position with /purge TOKEN.");
    return true;
  }
  const symbol = String(args[1] || "").trim().toUpperCase();
  const allowed = ["BTC","ETH","BNB","XRP","HYPE","ONDO","KPEPE","TRX","AAVE","ADA","DOGE","LINK","PUMP","SEI","SOL","SUI","UNI","VIRTUAL"];
  if (!allowed.includes(symbol)) {
    await sendTelegram(env, "Unsupported LeverUp market: " + symbol + ". Use one supported token symbol.");
    return true;
  }

  // Manual commands bypass only strategy candidate discovery/review. They do
  // not override live-mode flags, the kill switch, venue checks, or portfolio risk.
  try {
    const [liveEnabled, liveEntriesEnabled] = await Promise.all([
      readTradingControl(env, "ciel:control:live-enabled", null),
      readTradingControl(env, "ciel:control:live-entry-enabled", "false")
    ]);
    if (String(liveEnabled).toLowerCase() !== "true" ||
        String(liveEntriesEnabled).toLowerCase() !== "true" ||
        String(env?.LEVERUP_LIVE_TRADING).toLowerCase() !== "true" ||
        String(env?.LEVERUP_KILL_SWITCH).toLowerCase() !== "false") {
      await sendTelegram(env, "MANUAL LIVE TEST BLOCKED — live entries are not fully enabled in Cloudflare and D1. No order was submitted.");
      return true;
    }
    if (String(env?.LEVERUP_PREFLIGHT_ENABLED).toLowerCase() !== "true") {
      await sendTelegram(env, "MANUAL LIVE TEST BLOCKED — LeverUp preflight is disabled. No order was submitted.");
      return true;
    }

    const side = command === "/long" ? "LONG" : "SHORT";
    const signalId = "MANUAL-" + crypto.randomUUID().replace(/-/g, "").slice(0, 20).toUpperCase();
    const candidate = {
      id: signalId, symbol, side, mode: "MANUAL_EXECUTION_TEST",
      stopPct: 0.25, targetPct: 0.5, holdMinutes: 3,
      ...(Number(env?.LEVERUP_DEFAULT_LEVERAGE) > 0 ? { leverage: Number(env.LEVERUP_DEFAULT_LEVERAGE) } : {})
    };
    // The explicit Telegram command is the operator's approval to skip the
    // strategy signal gate. Passing zero margin selects the venue minimum;
    // normal deterministic allocation and risk checks still clamp the plan.
    const record = await prepareLeverUpAdvisorPlan({
      env, candidate,
      reviewed: { verdict: "APPROVE", liveMarginMon: 0, rationale: "Operator-triggered execution-path test; strategy signal gate bypassed only." },
      signalId, now: Date.now(), technicalOnly: false
    });
    const execution = record?.coordination || {};
    const submitted = execution.submitted === true ||
      ["SUBMITTED", "PENDING", "UNCERTAIN"].includes(String(execution.status || "").toUpperCase());
    const lines = [
      "CIEL MANUAL EXECUTION TEST — " + side + " " + symbol,
      "Preflight: " + String(record?.status || "UNKNOWN"),
      "Execution: " + String(execution.status || "NOT SUBMITTED"),
      "Leverage: " + String(record?.selectedLeverage ?? "—") + "x",
      "Margin: " + String(record?.marginMonUsed ?? record?.minimumMarginMon ?? "—") + " MON",
      "Stop / target: 0.25% / 0.50%",
      "Intent: " + (execution.intentHash || "none"),
      "Order submitted: " + (submitted ? "YES — awaiting position confirmation" : "NO"),
      "Approval policy: exact allowance only if required; no unlimited approval"
    ];
    if (execution.reason) lines.push("Reason: " + String(execution.reason).slice(0, 220));
    if (Array.isArray(execution.reasons) && execution.reasons.length) lines.push("Risk/checks: " + execution.reasons.join(", ").slice(0, 220));
    if (submitted) lines.push("", "After the position is confirmed, use /purge " + symbol + " to close it. Do not issue another entry until the previous position is closed and reconciled.");
    else lines.push("", "No position should be assumed. Read the rejection reason before retrying.");
    await sendTelegram(env, lines.join("\\n"));
  } catch (error) {
    await sendTelegram(env, "CIEL MANUAL EXECUTION TEST — " + symbol + "\\nFAILED: " + String(error?.message || error).slice(0, 260) + "\\nOrder submitted: UNKNOWN — verify the LeverUp intent ledger before retrying.");
  }
  return true;
}
__name(handleLeverUpManualEntryCommand, "handleLeverUpManualEntryCommand");
`;

const anchor = "async function handleCommand(env, text) {";
once(anchor, helper + anchor, "add /long and /short handler using the normal LeverUp advisor execution path");

const dispatch = '  if (await handleLeverUpPreflightCommand(env, text)) return;';
once(dispatch, dispatch + '\n  if (await handleLeverUpManualEntryCommand(env, text)) return;', "dispatch manual commands before other Telegram handlers");

await writeFile(file, source);
const debugLines = source.split("\n");
console.log("SYNTAX DEBUG AROUND EXPORT:\n" + debugLines.slice(4455, 4482).map((line, index) => (4456 + index) + ": " + line).join("\n"));
console.log("Wrote manual LeverUp execution-test command.");
