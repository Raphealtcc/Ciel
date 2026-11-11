import { readFile, writeFile } from "node:fs/promises";

const file = "reconstructed/patched-worker.js";
let source = await readFile(file, "utf8");

function replaceOnce(text, before, after, label) {
  const count = text.split(before).length - 1;
  if (count !== 1) throw new Error(label + ": expected exactly one match, found " + count);
  return text.replace(before, after);
}

function replaceRegexOnce(text, pattern, replacement, label) {
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(label + ": expected exactly one match, found " + matches.length);
  return text.replace(pattern, replacement);
}

const methodStart = source.indexOf("  async writeCoreScalpCandles(now) {");
const methodEnd = source.indexOf("  async writeHistory(rows, alerts, now) {", methodStart);
if (methodStart < 0 || methodEnd <= methodStart) throw new Error("Core scalp candle writer boundaries missing.");

let method = source.slice(methodStart, methodEnd);
method = replaceOnce(
  method,
  '    const symbols = ["BTC", "ETH", "SOL", "BNB", "HYPE", "ZEC"].filter((symbol) => Number(this.latest[symbol]) > 0);',
  '    const minLeverage = Number(this.env?.LEVERUP_MIN_LEVERAGE || 50);\n    const symbols = ["BTC", "ETH", "SOL", "BNB", "HYPE", "ZEC"].filter((symbol) => Number(this.latest[symbol]) > 0 && Number(LEVERUP_MARKET_MAX_LEVERAGE[symbol]) >= minLeverage);',
  "fetch 1m candles only for markets executable at the configured leverage floor",
);
method = replaceOnce(
  method,
  '        try {\n          const response = await fetch(HYPERLIQUID_INFO, {',
  '        try {\n          const existing = Array.isArray(this.coreScalpCandles[symbol]) ? this.coreScalpCandles[symbol] : [];\n          const oldest = Number(existing[0]?.open_ts_ms || 0);\n          const needsBootstrap = existing.length < 180 || oldest > now - 175 * 6e4;\n          const lookbackMinutes = needsBootstrap ? 210 : 15;\n          const response = await fetch(HYPERLIQUID_INFO, {',
  "bootstrap enough 1m samples for the local forecast",
);
method = replaceRegexOnce(method, /startTime:\s*now\s*-\s*75\s*\*\s*(?:60e3|6e4)/, "startTime: now - lookbackMinutes * 6e4", "use 210m bootstrap and 15m rolling candle fetches");
method = replaceRegexOnce(
  method,
  /const merged = new Map\(\(Array\.isArray\(this\.coreScalpCandles\[symbol\]\) \? this\.coreScalpCandles\[symbol\] : \[\]\)\s*\.map\(\(row\) => \[Number\(row\.open_ts_ms\), row\]\)\);/,
  "const merged = new Map(existing.map((row) => [Number(row.open_ts_ms), row]));",
  "merge rolling candles into the persistent cache",
);
const capCount = method.split(".slice(-90)").length - 1;
if (capCount !== 2) throw new Error("Expected two 90-candle caps, found " + capCount);
method = method.replaceAll(".slice(-90)", ".slice(-240)");
source = source.slice(0, methodStart) + method + source.slice(methodEnd);

source = replaceOnce(
  source,
  '    if (!isTemporaryMarketAllowed(candidate.symbol)) continue;\n    const isScalpMode =',
  '    if (!isTemporaryMarketAllowed(candidate.symbol)) continue;\n    const venueMaxLeverage = Number(LEVERUP_MARKET_MAX_LEVERAGE[candidate.symbol]);\n    const configuredMinLeverage = Number(env?.LEVERUP_MIN_LEVERAGE || 50);\n    if (Number.isFinite(venueMaxLeverage) && venueMaxLeverage < configuredMinLeverage) {\n      scanDiagnostics.push({ symbol: candidate.symbol, reason: "VENUE_MAX_LEVERAGE_BELOW_CONFIGURED_MINIMUM", venueMaxLeverage, configuredMinLeverage });\n      continue;\n    }\n    const isScalpMode =',
  "do not send below-floor markets to review or execution",
);

source = replaceOnce(
  source,
  'candleLevelSymbols: candleStructureRows.size, coreMarkets: ["BTC", "ETH", "SOL"], scalpMarkets: ["BTC", "ETH", "SOL", "BNB", "HYPE", "ZEC"], preferredGroup,',
  'candleLevelSymbols: candleStructureRows.size, oneMinuteCandleCounts: Object.fromEntries(Object.entries(coreScalpCandles || {}).map(([symbol, rows]) => [symbol, Array.isArray(rows) ? rows.length : 0])), fiveMinuteCandleCounts: Object.fromEntries(Object.entries(coreTrendCandles || {}).map(([symbol, rows]) => [symbol, Array.isArray(rows) ? rows.length : 0])), coreMarkets: ["BTC", "ETH", "SOL"], scalpMarkets: ["BTC", "ETH", "SOL", "BNB", "HYPE"], unsupportedLeverageMarkets: symbols.filter((symbol) => Number.isFinite(Number(LEVERUP_MARKET_MAX_LEVERAGE[symbol])) && Number(LEVERUP_MARKET_MAX_LEVERAGE[symbol]) < Number(env?.LEVERUP_MIN_LEVERAGE || 50)), preferredGroup,',
  "record per-symbol candle coverage and unsupported leverage markets",
);

const runStart = source.indexOf("async function runAdvisorCycle(");
const runMarker = '__name(runAdvisorCycle, "runAdvisorCycle");';
const runEnd = source.indexOf(runMarker, runStart);
if (runStart < 0 || runEnd < 0 || source.includes("reviewCompletedAt: now")) {
  throw new Error("Advisor cycle diagnostics insertion point missing or already patched.");
}
const functionClose = source.lastIndexOf("}", runEnd);
if (functionClose < runStart) throw new Error("Advisor cycle closing brace not found.");
source = source.slice(0, functionClose) +
  '  await env.CIEL_STATE.put("ciel:advisor:last-scan", JSON.stringify({ ...scanSnapshot, scanDiagnostics: scanDiagnostics.slice(-120), reviewCompletedAt: now }), { expirationTtl: 86400 }).catch(() => void 0);\n' +
  source.slice(functionClose);

await writeFile(file, source);
console.log("Applied CIEL incident repair: 1m forecast history, leverage eligibility and post-review diagnostics.");
