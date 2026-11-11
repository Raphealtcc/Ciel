import { readFile, writeFile } from "node:fs/promises";

const file = "reconstructed/patched-worker.js";
let source = await readFile(file, "utf8");

function once(before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(label + ": expected exactly one match, found " + count);
  source = source.replace(before, after);
  console.log("Applied runtime budget fix: " + label);
}

// The initial four-day bootstrap wrote every 5m candle twice: once to market_candles
// and again to market_samples. D1 keeps a 24h native candle archive; the live sampler
// owns market_samples. Check coverage against the candle archive's existing index.
const bootstrapStart = source.indexOf("  async bootstrapBenchmarkHistory(now) {");
const bootstrapEnd = source.indexOf("  async writeCandleSnapshots(now) {", bootstrapStart);
if (bootstrapStart < 0 || bootstrapEnd <= bootstrapStart) throw new Error("Historical bootstrap function not found");
let bootstrap = source.slice(bootstrapStart, bootstrapEnd);
function replaceBootstrapOnce(before, after, label) {
  const count = bootstrap.split(before).length - 1;
  if (count !== 1) throw new Error(label + ": expected exactly one match, found " + count);
  bootstrap = bootstrap.replace(before, after);
}
replaceBootstrapOnce("const startTime = now - 4 * 86400000;", "const startTime = now - 24 * 60 * 60 * 1000;", "bound bootstrap to 24h");
replaceBootstrapOnce(
  `const coverage = await this.env.DB.prepare("SELECT COUNT(*) AS n,MIN(ts_ms) AS first_ts FROM market_samples WHERE symbol=? AND ts_ms>=?").bind(symbol,startTime).first();`,
  `const coverage = await this.env.DB.prepare("SELECT COUNT(*) AS n,MIN(open_ts_ms) AS first_ts FROM market_candles WHERE symbol=? AND interval='5m' AND open_ts_ms>=?").bind(symbol,startTime).first();`,
  "measure existing candle archive coverage",
);
replaceBootstrapOnce(
  "if (Number(coverage?.n || 0) >= 600 && Number(coverage?.first_ts || 0) <= now - 3 * 86400000) continue;",
  "if (Number(coverage?.n || 0) >= 200 && Number(coverage?.first_ts || 0) <= now - 20 * 60 * 60 * 1000) continue;",
  "use a valid 24h coverage threshold",
);
replaceBootstrapOnce(
  'if (validCount < 600) throw new Error(symbol + " historical candle response was too short (" + validCount + " rows)");',
  'if (validCount < 200) { console.warn("Historical candle bootstrap skipped " + symbol + ": only " + validCount + " valid candles were returned."); continue; }',
  "allow partial history for one market without aborting other markets",
);
const sampleInsert = 'statements.push(this.env.DB.prepare("INSERT OR IGNORE INTO market_samples (ts_ms,symbol,mid_price) VALUES (?,?,?)").bind(closeAt,symbol,close));';
replaceBootstrapOnce(sampleInsert, "", "remove duplicate historical market_samples writes");
source = source.slice(0, bootstrapStart) + bootstrap + source.slice(bootstrapEnd);
console.log("Applied runtime budget fix: bounded bootstrap and no duplicate sample writes");

// Keep six samples/hour for wider symbols; do not write the full watchlist every minute.
once(
  "const persistAllSamples = Math.floor(now / (6 * 60 * 1e3)) !== Math.floor((now - SAMPLE_INTERVAL_MS) / (6 * 60 * 1e3));",
  "const persistAllSamples = Math.floor(now / (10 * 60 * 1e3)) !== Math.floor((now - SAMPLE_INTERVAL_MS) / (10 * 60 * 1e3));",
  "reduce wider-watchlist sample persistence from every 6m to every 10m",
);

// Cache empty intraday history for an hour; otherwise a missing symbol can repeat the
// same 7,200-row D1 scan on every advisor cycle.
const intradayStart = source.indexOf("async function getIntradayPattern(env,symbol,now,currentPrice){");
const intradayEnd = source.indexOf('__name(getIntradayPattern,"getIntradayPattern");', intradayStart);
if (intradayStart < 0 || intradayEnd <= intradayStart) throw new Error("Intraday pattern function not found");
let intraday = source.slice(intradayStart, intradayEnd);
const cacheAnchor = "if(cached&&cached.schemaVersion===2&&cached.localDay===today&&cached.hourStats&&(Number(cached.historyDays)>=5||now-Number(cached.computedAt||0)<24*60*60*1000))return await present(cached,true);";
if (intraday.split(cacheAnchor).length - 1 !== 1) throw new Error("Intraday cache anchor not found");
intraday = intraday.replace(
  cacheAnchor,
  cacheAnchor + '\n const emptyCacheKey="ciel:intraday-empty:v1:"+symbol+":"+today;\n const emptyCachedAt=Number(await env.CIEL_STATE.get(emptyCacheKey).catch(()=>0));\n if(emptyCachedAt&&now-emptyCachedAt<60*60*1000)return empty("No stored sampled price history; empty result cached for one hour.");'
);
const noRows = 'if(!hours.length)return empty("No stored sampled price history is available yet.");';
if (intraday.split(noRows).length - 1 !== 1) throw new Error("Intraday empty-result branch not found");
intraday = intraday.replace(
  noRows,
  'if(!hours.length){\n  await env.CIEL_STATE.put(emptyCacheKey,String(now),{expirationTtl:3600}).catch(()=>void 0);\n  return empty("No stored sampled price history is available yet.");\n }\n await env.CIEL_STATE.delete(emptyCacheKey).catch(()=>void 0);'
);
source = source.slice(0, intradayStart) + intraday + source.slice(intradayEnd);
console.log("Applied runtime budget fix: cache empty intraday history in KV");

// Repeated market-quality and positioning rejections were inserting an audit row every
// minute before review cooldowns were set. Throttle these diagnostic rows in KV.
const helperAnchor = "let liveEntrySubmittedThisCycle=false,proposalCountThisCycle=0;";
const helper = helperAnchor + '\n  const persistRejectedAudit=async(reasonKey,write)=>{\n    const key="ciel:advisor:audit-throttle:v1:"+reasonKey;\n    const previous=Number(await env.CIEL_STATE.get(key).catch(()=>0));\n    if(previous&&now-previous<15*60*1000)return false;\n    await env.CIEL_STATE.put(key,String(now),{expirationTtl:3600}).catch(()=>void 0);\n    await write();\n    return true;\n  };';
once(helperAnchor, helper, "add KV-only 15m rejection-audit throttle");

const marketAudit = 'await env.DB.prepare("INSERT INTO advisor_ai_audit(created_at_ms,symbol,side,model,verdict,reason,risk_flags,search_queries,grounding_sources,market_context_json) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(now,candidate.symbol,candidate.side,"Hyperliquid market-quality gate","WAIT",reason,JSON.stringify(["MARKET_QUALITY_GATE"]),JSON.stringify([]),JSON.stringify([]),JSON.stringify(quality.market)).run();';
once(marketAudit, 'await persistRejectedAudit("market-quality:"+candidate.symbol,()=>env.DB.prepare("INSERT INTO advisor_ai_audit(created_at_ms,symbol,side,model,verdict,reason,risk_flags,search_queries,grounding_sources,market_context_json) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(now,candidate.symbol,candidate.side,"Hyperliquid market-quality gate","WAIT",reason,JSON.stringify(["MARKET_QUALITY_GATE"]),JSON.stringify([]),JSON.stringify([]),JSON.stringify(quality.market)).run());', "throttle repeated market-quality audit writes");

const crowdAudit = 'await env.DB.prepare("INSERT INTO advisor_ai_audit(created_at_ms,symbol,side,model,verdict,reason,risk_flags,search_queries,grounding_sources,market_context_json) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(now,candidate.symbol,candidate.side,"CIEL deterministic positioning gate","WAIT",reason,JSON.stringify(flags),JSON.stringify([]),JSON.stringify([]),JSON.stringify({ ...reviewerMarket, rsi:candidate.rsi })).run();';
once(crowdAudit, 'await persistRejectedAudit("positioning:"+candidate.symbol,()=>env.DB.prepare("INSERT INTO advisor_ai_audit(created_at_ms,symbol,side,model,verdict,reason,risk_flags,search_queries,grounding_sources,market_context_json) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(now,candidate.symbol,candidate.side,"CIEL deterministic positioning gate","WAIT",reason,JSON.stringify(flags),JSON.stringify([]),JSON.stringify([]),JSON.stringify({ ...reviewerMarket, rsi:candidate.rsi })).run());', "throttle repeated deterministic-positioning audit writes");

await writeFile(file, source);
console.log("Runtime budget patch complete.");
