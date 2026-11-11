import { readFile, writeFile } from "node:fs/promises";

const file = "reconstructed/patched-worker.js";
let source = await readFile(file, "utf8");

function once(before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(label + ": expected one anchor, found " + count);
  source = source.replace(before, after);
  console.log("Applied runtime budget fix: " + label);
}

// The four-day bootstrap duplicated every historical 5m candle into market_samples.
// The strategy already has native 5m candles in DO state; keep a 24h D1 archive only.
const bootstrapStart = source.indexOf("  async bootstrapBenchmarkHistory(now) {");
const bootstrapEnd = source.indexOf("  async writeCandleSnapshots(now) {", bootstrapStart);
if (bootstrapStart < 0 || bootstrapEnd <= bootstrapStart) throw new Error("Historical bootstrap function not found");
let bootstrap = source.slice(bootstrapStart, bootstrapEnd);
const oldWindow = "    const startTime = now - 4 * 864e5;";
if (bootstrap.split(oldWindow).length - 1 !== 1) throw new Error("Expected one four-day bootstrap window");
bootstrap = bootstrap.replace(oldWindow, "    const startTime = now - 24 * 60 * 60 * 1e3;");
const sampleInsert = '          statements.push(this.env.DB.prepare("INSERT OR IGNORE INTO market_samples (ts_ms,symbol,mid_price) VALUES (?,?,?)").bind(closeAt, symbol, close));\n';
if (bootstrap.split(sampleInsert).length - 1 !== 1) throw new Error("Expected one duplicated bootstrap sample insert");
bootstrap = bootstrap.replace(sampleInsert, "");
source = source.slice(0, bootstrapStart) + bootstrap + source.slice(bootstrapEnd);
console.log("Applied runtime budget fix: bound bootstrap to 24h and remove duplicate historical market_samples writes");

// Six samples/hour are enough for the existing intraday hourly pattern calculation.
once(
  "const persistAllSamples = Math.floor(now / (6 * 60 * 1e3)) !== Math.floor((now - SAMPLE_INTERVAL_MS) / (6 * 60 * 1e3));",
  "const persistAllSamples = Math.floor(now / (10 * 60 * 1e3)) !== Math.floor((now - SAMPLE_INTERVAL_MS) / (10 * 60 * 1e3));",
  "reduce wider-watchlist sample persistence from every 6m to every 10m",
);

// Empty history was not cached, so a candidate without samples could repeat the same
// 7,200-row D1 scan every advisor cycle. Cache that empty result briefly in KV.
const intradayStart = source.indexOf("async function getIntradayPattern(env, symbol, now, currentPrice) {");
const intradayEnd = source.indexOf("__name(getIntradayPattern", intradayStart);
if (intradayStart < 0 || intradayEnd <= intradayStart) throw new Error("Intraday pattern function not found");
let intraday = source.slice(intradayStart, intradayEnd);
const cacheAnchor = '    if (cached && cached.schemaVersion === 2 && cached.localDay === today && cached.hourStats && (Number(cached.historyDays) >= 5 || now - Number(cached.computedAt || 0) < 24 * 60 * 60 * 1e3)) return await present(cached, true);';
if (intraday.split(cacheAnchor).length - 1 !== 1) throw new Error("Intraday cache anchor not found");
intraday = intraday.replace(cacheAnchor, cacheAnchor + '\n    const emptyCacheKey = "ciel:intraday-empty:v1:" + symbol + ":" + today;\n    const emptyCachedAt = Number(await env.CIEL_STATE.get(emptyCacheKey).catch(() => 0));\n    if (emptyCachedAt && now - emptyCachedAt < 60 * 60 * 1e3) return empty("No stored sampled price history; empty result cached for one hour.");');
const noRows = '    if (!hours.length) return empty("No stored sampled price history is available yet.");';
if (intraday.split(noRows).length - 1 !== 1) throw new Error("Intraday empty-result branch not found");
intraday = intraday.replace(noRows, '    if (!hours.length) {\n      await env.CIEL_STATE.put(emptyCacheKey, String(now), { expirationTtl: 3600 }).catch(() => void 0);\n      return empty("No stored sampled price history is available yet.");\n    }\n    await env.CIEL_STATE.delete(emptyCacheKey).catch(() => void 0);');
source = source.slice(0, intradayStart) + intraday + source.slice(intradayEnd);
console.log("Applied runtime budget fix: cache missing intraday history to stop repeated D1 scans");

// Rejected candidates were writing an audit row every minute before review cooldowns
// were set. Keep the first diagnostic row and suppress duplicates for 15 minutes.
const helperAnchor = '  let liveEntrySubmittedThisCycle = false, proposalCountThisCycle = 0;\n  const maxProposalsPerCycle = 3;';
const helperReplacement = helperAnchor + '\n  const persistRejectedAudit = async (reasonKey, write) => {\n    const key = "ciel:advisor:audit-throttle:v1:" + reasonKey;\n    const previous = Number(await env.CIEL_STATE.get(key).catch(() => 0));\n    if (previous && now - previous < 15 * 60 * 1e3) return false;\n    await env.CIEL_STATE.put(key, String(now), { expirationTtl: 3600 }).catch(() => void 0);\n    await write();\n    return true;\n  };';
once(helperAnchor, helperReplacement, "add a KV-only 15m rejection-audit throttle");

const marketAudit = 'await env.DB.prepare("INSERT INTO advisor_ai_audit(created_at_ms,symbol,side,model,verdict,reason,risk_flags,search_queries,grounding_sources,market_context_json) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(now, candidate.symbol, candidate.side, "Hyperliquid market-quality gate", "WAIT", reason, JSON.stringify(["MARKET_QUALITY_GATE"]), JSON.stringify([]), JSON.stringify([]), JSON.stringify(quality.market)).run();';
once(marketAudit, 'await persistRejectedAudit("market-quality:" + candidate.symbol, () => env.DB.prepare("INSERT INTO advisor_ai_audit(created_at_ms,symbol,side,model,verdict,reason,risk_flags,search_queries,grounding_sources,market_context_json) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(now, candidate.symbol, candidate.side, "Hyperliquid market-quality gate", "WAIT", reason, JSON.stringify(["MARKET_QUALITY_GATE"]), JSON.stringify([]), JSON.stringify([]), JSON.stringify(quality.market)).run());', "throttle repeated missing-market-evidence audit writes");

const crowdAudit = 'await env.DB.prepare("INSERT INTO advisor_ai_audit(created_at_ms,symbol,side,model,verdict,reason,risk_flags,search_queries,grounding_sources,market_context_json) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(now, candidate.symbol, candidate.side, "CIEL deterministic positioning gate", "WAIT", reason, JSON.stringify(flags), JSON.stringify([]), JSON.stringify([]), JSON.stringify({ ...reviewerMarket, rsi: candidate.rsi })).run();';
once(crowdAudit, 'await persistRejectedAudit("positioning:" + candidate.symbol, () => env.DB.prepare("INSERT INTO advisor_ai_audit(created_at_ms,symbol,side,model,verdict,reason,risk_flags,search_queries,grounding_sources,market_context_json) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(now, candidate.symbol, candidate.side, "CIEL deterministic positioning gate", "WAIT", reason, JSON.stringify(flags), JSON.stringify([]), JSON.stringify([]), JSON.stringify({ ...reviewerMarket, rsi: candidate.rsi })).run());', "throttle repeated deterministic-positioning audit writes");

await writeFile(file, source);
console.log("Runtime budget patch complete.");
