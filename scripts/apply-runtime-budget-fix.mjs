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
// and again to market_samples. The DO keeps live 5m strategy candles, so D1 only needs
// a 24h candle archive; market_samples is filled by the live sampler.
const bootstrapStart = source.indexOf("  async bootstrapBenchmarkHistory(now) {");
const bootstrapEnd = source.indexOf("  async writeCandleSnapshots(now) {", bootstrapStart);
if (bootstrapStart < 0 || bootstrapEnd <= bootstrapStart) throw new Error("Historical bootstrap function not found");
let bootstrap = source.slice(bootstrapStart, bootstrapEnd);
const oldWindow = "const startTime = now - 4 * 86400000;";
if (bootstrap.split(oldWindow).length - 1 !== 1) throw new Error("Expected one four-day bootstrap window");
bootstrap = bootstrap.replace(oldWindow, "const startTime = now - 24 * 60 * 60 * 1000;");
const sampleInsert = 'statements.push(this.env.DB.prepare("INSERT OR IGNORE INTO market_samples (ts_ms,symbol,mid_price) VALUES (?,?,?)").bind(closeAt,symbol,close));';
if (bootstrap.split(sampleInsert).length - 1 !== 1) throw new Error("Expected one duplicated bootstrap market_samples insert");
bootstrap = bootstrap.replace(sampleInsert, "");
source = source.slice(0, bootstrapStart) + bootstrap + source.slice(bootstrapEnd);
console.log("Applied runtime budget fix: 24h bootstrap and no duplicate historical market_samples writes");

// Keep six samples/hour for wider symbols; do not write the full watchlist every minute.
once(
  "const persistAllSamples = Math.floor(now / (6 * 60 * 1e3)) !== Math.floor((now - SAMPLE_INTERVAL_MS) / (6 * 60 * 1e3));",
  "const persistAllSamples = Math.floor(now / (10 * 60 * 1e3)) !== Math.floor((now - SAMPLE_INTERVAL_MS) / (10 * 60 * 1e3));",
  "reduce wider-watchlist sample persistence from every 6m to every 10m",
);

// Empty intraday history previously returned without a cache entry. Cache the empty
// result for an hour so a symbol with no samples cannot repeat the same 7,200-row read.
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

// Repeated market-quality and deterministic-positioning rejections were inserting an
// audit row every minute before the review cooldown was written. Throttle those rows
// by symbol/reason in KV; keep D1 for durable, meaningful review records.
const helperAnchor = "let liveEntrySubmittedThisCycle=false,proposalCountThisCycle=0;";
const helper = helperAnchor + '\n  const persistRejectedAudit=async(reasonKey,write)=>{\n    const key="ciel:advisor:audit-throttle:v1:"+reasonKey;\n    const previous=Number(await env.CIEL_STATE.get(key).catch(()=>0));\n    if(previous&&now-previous<15*60*1000)return false;\n    await env.CIEL_STATE.put(key,String(now),{expirationTtl:3600}).catch(()=>void 0);\n    await write();\n    return true;\n  };';
once(helperAnchor, helper, "add KV-only 15m rejection-audit throttle");

const marketAudit = 'await env.DB.prepare("INSERT INTO advisor_ai_audit(created_at_ms,symbol,side,model,verdict,reason,risk_flags,search_queries,grounding_sources,market_context_json) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(now,candidate.symbol,candidate.side,"Hyperliquid market-quality gate","WAIT",reason,JSON.stringify(["MARKET_QUALITY_GATE"]),JSON.stringify([]),JSON.stringify([]),JSON.stringify(quality.market)).run();';
once(marketAudit, 'await persistRejectedAudit("market-quality:"+candidate.symbol,()=>env.DB.prepare("INSERT INTO advisor_ai_audit(created_at_ms,symbol,side,model,verdict,reason,risk_flags,search_queries,grounding_sources,market_context_json) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(now,candidate.symbol,candidate.side,"Hyperliquid market-quality gate","WAIT",reason,JSON.stringify(["MARKET_QUALITY_GATE"]),JSON.stringify([]),JSON.stringify([]),JSON.stringify(quality.market)).run());', "throttle repeated missing-market-evidence audit writes");

const crowdAudit = 'await env.DB.prepare("INSERT INTO advisor_ai_audit(created_at_ms,symbol,side,model,verdict,reason,risk_flags,search_queries,grounding_sources,market_context_json) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(now,candidate.symbol,candidate.side,"CIEL deterministic positioning gate","WAIT",reason,JSON.stringify(flags),JSON.stringify([]),JSON.stringify([]),JSON.stringify({ ...reviewerMarket, rsi:candidate.rsi })).run();';
once(crowdAudit, 'await persistRejectedAudit("positioning:"+candidate.symbol,()=>env.DB.prepare("INSERT INTO advisor_ai_audit(created_at_ms,symbol,side,model,verdict,reason,risk_flags,search_queries,grounding_sources,market_context_json) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(now,candidate.symbol,candidate.side,"CIEL deterministic positioning gate","WAIT",reason,JSON.stringify(flags),JSON.stringify([]),JSON.stringify([]),JSON.stringify({ ...reviewerMarket, rsi:candidate.rsi })).run());', "throttle repeated deterministic-positioning audit writes");

await writeFile(file, source);
console.log("Runtime budget patch complete.");
