import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const file = path.join(process.cwd(), "reconstructed", "patched-worker.js");
let source = await readFile(file, "utf8");

function once(before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(label + ": expected exactly one match, found " + count);
  source = source.replace(before, after);
  console.log("Applied purge command: " + label);
}

const imports = [
  'import { purgeLeverUpPositions } from "../src/leverup-coordinator.js";',
  'import { purgePaperTrades } from "../src/purge-paper.js";',
];
for (const line of imports) if (!source.includes(line)) source = line + "\n" + source;

once(
  'async function getPaperSummary(storage, prices, now, lastTickAt) {',
  'async function purgePaperTradesNow(storage, prices, now, lastTickAt, symbol) {\n' +
  '  return purgePaperTrades({ storage, accountKey: PAPER_ACCOUNT_KEY, prices, now, lastTickAt, symbol, maxAgeMs: MAX_AGE });\n' +
  '}\n' +
  'async function getPaperSummary(storage, prices, now, lastTickAt) {',
  "expose transactional mark-to-market paper close",
);

once(
  '    if (path === "/paper/profits") {',
  '    if (path === "/paper/purge" && request.method === "POST") {\n' +
  '      try {\n' +
  '        const body = await request.json().catch(() => ({}));\n' +
  '        const symbol = typeof body?.symbol === "string" ? body.symbol.trim() : "";\n' +
  '        const result = await purgePaperTradesNow(this.state.storage, this.latest, Date.now(), this.lastTickAt, symbol);\n' +
  '        return json({ ok: true, ...result });\n' +
  '      } catch (error) {\n' +
  '        const detail = String(error?.message || error).slice(0, 350);\n' +
  '        console.error("CIEL paper purge route failed: " + detail);\n' +
  '        return json({ ok: false, error: "PAPER_PURGE_FAILED", detail }, 500);\n' +
  '      }\n' +
  '    }\n' +
  '    if (path === "/paper/profits") {',
  "add private Durable Object paper purge endpoint",
);

once(
  '  if (!["/signals", "/positions", "/entered", "/cancel", "/profits"].includes(cmd)) return false;',
  '  if (!["/signals", "/positions", "/entered", "/cancel", "/profits", "/purge"].includes(cmd)) return false;',
  "register Telegram purge command",
);

once(
  '  if (cmd === "/entered") {',
  '  if (cmd === "/purge") {\n' +
  '    if (a.length > 2) { await notify(env, "Usage: /purge or /purge TOKEN (example: /purge BTC)."); return true; }\n' +
  '    const token = a[1] ? String(a[1]).trim().toUpperCase() : null;\n' +
  '    if (token && !/^[A-Z0-9][A-Z0-9._\\/-]{0,31}$/.test(token)) { await notify(env, "Invalid token. Usage: /purge or /purge TOKEN."); return true; }\n' +
  '    let paper = null, paperError = null, live = null, liveError = null;\n' +
  '    try {\n' +
  '      const response = await feedStub(env).fetch("https://feed/paper/purge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbol: token }) });\n' +
  '      paper = await response.json().catch(() => null);\n' +
  '      if (!response.ok || !paper?.ok) paperError = String(paper?.detail || paper?.error || "HTTP " + response.status).slice(0, 180);\n' +
  '    } catch (error) { paperError = String(error?.message || error).slice(0, 180); }\n' +
  '    try { live = await purgeLeverUpPositions({ env, db: env.DB, symbol: token, now: Date.now() }); }\n' +
  '    catch (error) { liveError = String(error?.message || error).slice(0, 180); }\n' +
  '    const sign = (value) => (Number(value) >= 0 ? "+" : "") + Number(value || 0).toFixed(3);\n' +
  '    const lines = ["🧹 CIEL PURGE — " + (token || "ALL TOKENS")];\n' +
  '    lines.push("", "PAPER: " + (paperError ? "FAILED — " + paperError : (paper.closedCount || 0) + " closed, " + (paper.skippedCount || 0) + " skipped"));\n' +
  '    for (const item of (paper?.closed || []).slice(0, 8)) lines.push("• " + item.side + " " + item.symbol + " | " + sign(item.pnlMon) + " MON | mark $" + fmt(item.exitPrice));\n' +
  '    if (paper?.skipped?.length) lines.push("Paper positions left open (no fresh mark): " + paper.skipped.map((x) => x.symbol).slice(0, 8).join(", "));\n' +
  '    lines.push("", "LEVERUP LIVE: " + (liveError ? "FAILED — " + liveError : (live?.status || "UNKNOWN") + " | " + (live?.submitted || 0) + " close intent(s) submitted | " + (live?.openPositionCount || 0) + " position(s) discovered"));\n' +
  '    if (live?.status === "LIVE_DISABLED") lines.push("Live close was not submitted: LEVERUP_LIVE_TRADING is OFF.");\n' +
  '    if (live?.killSwitchBypassedForRiskReducingClose) lines.push("Emergency close-only path used; the kill switch still blocks new entries.");\n' +
  '    if (live?.readErrors?.length) lines.push("Live discovery errors: " + live.readErrors.length + " pair(s) could not be read.");\n' +
  '    lines.push("", "This command closes paper trades at the latest fresh Hyperliquid mark and submits market-close intents for live LeverUp positions. It does not open or reverse positions.");\n' +
  '    await notify(env, lines.join("\\n"));\n' +
  '    return true;\n' +
  '  }\n' +
  '  if (cmd === "/entered") {',
  "close paper and LeverUp positions by token or all tokens",
);

once(
  '      "/profits \\u2014 automatic 50x paper-trading balance and P&L",',
  '      "/profits — automatic 50x paper-trading balance and P&L",\n      "/purge — close all paper and live positions; /purge BTC closes BTC only",',
  "document purge command in Telegram help",
);

await writeFile(file, source);
console.log("Wrote purge-enabled Worker candidate: " + file);
