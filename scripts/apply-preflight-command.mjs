import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const file = path.join(process.cwd(), "reconstructed", "patched-worker.js");
let source = await readFile(file, "utf8");

function once(before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(label + ": expected exactly one match, found " + count);
  source = source.replace(before, after);
  console.log("Applied LeverUp Telegram preflight: " + label);
}

const helper = `async function handleLeverUpPreflightCommand(env, text) {
  const args = String(text || "").trim().split(/\\s+/).filter(Boolean);
  const command = (args[0] || "").split("@")[0].toLowerCase();
  if (command !== "/preflight") return false;
  if (args.length !== 2) {
    await sendTelegram(env, "Usage: /preflight TOKEN\\nRun exactly one market per command. Example: /preflight BTC");
    return true;
  }
  const symbol = String(args[1] || "").trim().toUpperCase();
  const allowed = ["BTC","ETH","BNB","XRP","HYPE","ONDO","KPEPE","TRX","AAVE","ADA","DOGE","LINK","PUMP","SEI","SOL","SUI","UNI","VIRTUAL"];
  if (!allowed.includes(symbol)) {
    await sendTelegram(env, "Unsupported LeverUp market: " + symbol + ". Send /preflight with one supported token symbol.");
    return true;
  }
  let result;
  try {
    result = await runLeverUpDiagnostics({ env, now: Date.now(), symbols: [symbol], skipCoordinator: true });
  } catch (error) {
    await sendTelegram(env, "LEVERUP PREFLIGHT — " + symbol + "\\nFAILED: " + String(error?.message || error).slice(0, 220) +
      "\\nMode: read-only\\nOrders submitted: NO\\nApprovals submitted: NO");
    return true;
  }
  const market = result?.marketPreflights?.[symbol] || {};
  const auth = result?.agentAuthorization || {};
  const balances = result?.balancesAndAllowances || {};
  const lines = [
    "LEVERUP PREFLIGHT — " + symbol,
    "Overall: " + String(result?.status || result?.mode || "UNKNOWN"),
    "Market: " + String(market.status || "NOT CHECKED") + (market.reason ? " — " + String(market.reason).slice(0, 150) : ""),
    "Leverage: " + String(market.selectedLeverage ?? "—") + "x / max " + String(market.marketMaxLeverage ?? "—") + "x",
    "Minimum margin: " + String(market.minimumMarginMon ?? "—") + " MON",
    "Trader signing: " + String(result?.traderSigning?.status || "UNKNOWN"),
    "Agent signing: " + String(result?.signing?.status || "UNKNOWN"),
    "Agent authorization: " + (auth.authorized ? "YES" : "NO") + " (open " + Boolean(auth.canMarketOpen) + ", close " + Boolean(auth.canMarketClose) + ", partial " + Boolean(auth.canPartialClose) + ")",
    "WMON balance/allowance: " + (balances.WMON ? "read" : "UNAVAILABLE"),
    "Native MON gas ready: " + (result?.nativeMonGasReady ? "YES" : "NO"),
    "Coordinator: SKIPPED (single-market command)",
    "Orders submitted: NO",
    "Approvals submitted: NO"
  ];
  await sendTelegram(env, lines.join("\\n"));
  return true;
}
__name(handleLeverUpPreflightCommand, "handleLeverUpPreflightCommand");
`;

const anchor = "async function handleCommand(env, text) {";
once(anchor, helper + anchor, "add one-market read-only command handler");

const dispatch = '  const command = (text.trim().split(/\\s+/, 1)[0] || "").split("@")[0].toLowerCase();';
once(dispatch, dispatch + '\\n  if (await handleLeverUpPreflightCommand(env, text)) return;', "dispatch /preflight before other Telegram command handlers");

const helpAnchor = '      "/modes — show effective trading modes",';
once(helpAnchor, helpAnchor + '\\n      "/preflight TOKEN — read-only LeverUp preflight for one market only",', "document single-market usage");

await writeFile(file, source);
console.log("Wrote single-market read-only preflight command.");
