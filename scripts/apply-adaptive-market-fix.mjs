import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const file = path.join(process.cwd(), "reconstructed", "patched-worker.js");
let source = await readFile(file, "utf8");
function once(before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(label + ": expected exactly one match, found " + count);
  source = source.replace(before, after);
  console.log("Applied adaptive core-market patch: " + label);
}

const learningHelpers = `
function buildAdaptiveLearningProfile(trades, now) {
  const closed = (Array.isArray(trades) ? trades : [])
    .filter((trade) => trade && trade.status === "CLOSED" &&
      Number(trade.closedAtMs) > 0 && Number(trade.closedAtMs) >= now - 90 * 86400e3 &&
      Number.isFinite(Number(trade.grossPnlMon)) && Number(trade.marginMon) > 0)
    .sort((a,b) => Number(a.closedAtMs)-Number(b.closedAtMs)).slice(-300);
  const buckets = new Map();
  function add(key, trade) { if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(trade); }
  for (const trade of closed) {
    const symbol = String(trade.symbol || "UNKNOWN").toUpperCase();
    const mode = String(trade.mode || "LEGACY");
    add("strategy:" + mode, trade);
    add("market:" + symbol + "|" + mode, trade);
  }
  function summarize(rows) {
    const count = rows.length;
    const wins = rows.filter((trade) => Number(trade.grossPnlMon) > 0).length;
    const losses = rows.filter((trade) => Number(trade.grossPnlMon) < 0).length;
    const pnlMon = rows.reduce((sum, trade) => sum + Number(trade.grossPnlMon), 0);
    const expectancyPct = rows.reduce((sum, trade) => sum + Number(trade.grossPnlMon) / Number(trade.marginMon) * 100, 0) / Math.max(1,count);
    const smoothedWinRate = (wins + 2) / (count + 4);
    const sampleWeight = Math.min(1,count/20);
    const winAdjustment = Math.max(-0.06,Math.min(0.06,(smoothedWinRate-0.5)*0.24));
    const expectancyAdjustment = Math.max(-0.04,Math.min(0.04,expectancyPct*0.01));
    const multiplier = count < 8 ? 1 : Math.max(0.9,Math.min(1.1,1+sampleWeight*(winAdjustment+expectancyAdjustment)));
    return {trades:count,wins,losses,winRate:count?wins/count:0,pnlMon,expectancyPct,multiplier,
      avgBestFavorableMovePct:rows.reduce((sum,trade)=>sum+(Number(trade.bestFavorableMovePct)||0),0)/Math.max(1,count),
      closeReasons:rows.reduce((out,trade)=>{const reason=String(trade.closeReason||"UNKNOWN");out[reason]=(out[reason]||0)+1;return out;},{})};
  }
  const byStrategy={},bySymbolStrategy={};
  for (const [key,rows] of buckets) {
    const summary=summarize(rows.slice(-40));
    if(key.startsWith("strategy:"))byStrategy[key.slice(9)]=summary;
    else bySymbolStrategy[key.slice(7)]=summary;
  }
  const latest=closed[closed.length-1];
  const fingerprint=closed.length+":"+(latest?latest.closedAtMs+":"+latest.signalId:"empty");
  return {version:1,updatedAtMs:now,sampleWindowDays:90,closedTradeCount:closed.length,fingerprint,byStrategy,bySymbolStrategy};
}
__name(buildAdaptiveLearningProfile,"buildAdaptiveLearningProfile");

function adaptiveCandidateMultiplier(profile,candidate) {
  const symbol=String(candidate.symbol||"").toUpperCase(),mode=String(candidate.mode||"LEGACY");
  const specific=profile?.bySymbolStrategy?.[symbol+"|"+mode],strategy=profile?.byStrategy?.[mode];
  const selected=specific&&specific.trades>=8?specific:strategy;
  return selected&&selected.trades>=8?Math.max(0.9,Math.min(1.1,Number(selected.multiplier)||1)):1;
}
__name(adaptiveCandidateMultiplier,"adaptiveCandidateMultiplier");
`;
const signature="async function runAdvisorCycle(env, prices, now, lastTickAt, priceHistory, liveEvidence, paperStorage, coreScalpCandles = {}) {";
once(signature,learningHelpers+signature,"add bounded paper-trade learning helpers");

once(
  "  const symbols = configuredWatchSymbols(env.WATCH_SYMBOLS);",
  '  const symbols = [...new Set(["BTC","ETH","SOL", ...configuredWatchSymbols(env.WATCH_SYMBOLS)])];',
  "keep BTC ETH SOL in the scan even when WATCH_SYMBOLS omits them"
);
once(
  "  const candidates = [];\n  for (const sym of symbols) {",
  '  const candidates = [];\n  const scanDiagnostics = [];\n  const coreMarketSet = new Set(["BTC","ETH","SOL"]);\n  const orderedSymbols = symbols.slice().sort((a,b) => Number(coreMarketSet.has(b))-Number(coreMarketSet.has(a)) || a.localeCompare(b));\n  for (const sym of orderedSymbols) {',
  "evaluate core markets first without removing other watchlist markets"
);
once(
  '    if (sym === "MON" || requiredPaperMargin === null || paperCash + 1e-9 < requiredPaperMargin || openPaperSymbols.has(sym)) continue;',
  '    if (sym === "MON") { scanDiagnostics.push({symbol:sym,reason:"NON_TRADEABLE_BASE_ASSET"}); continue; }\n    if (requiredPaperMargin === null) { scanDiagnostics.push({symbol:sym,reason:"BELOW_50X_OR_UNSUPPORTED_LEVERAGE_TIER"}); continue; }\n    if (paperCash + 1e-9 < requiredPaperMargin) { scanDiagnostics.push({symbol:sym,reason:"INSUFFICIENT_FREE_MARGIN",requiredPaperMargin,availablePaperMargin:paperCash}); continue; }\n    if (openPaperSymbols.has(sym)) { scanDiagnostics.push({symbol:sym,reason:"POSITION_ALREADY_OPEN"}); continue; }',
  "record eligibility, margin and open-position rejection reasons"
);

const oldCandidateBuild = `    const signal = analyse(sym, hist.get(sym) || [], now);
    const isCore = ["BTC","ETH","SOL"].includes(sym);
    if (signal && signal.confidence >= setting(env.ADVISORY_MIN_CONFIDENCE, 0.72, 0.5, 0.95) && (!isCore || signal.mode === "TREND_HOLD")) candidates.push(signal);
    if (isCore) {
      const candles = coreScalpData.get(sym);
      if (candles) {
        const scalp = analyzeCorePullbackScalp(sym,candles.one,candles.five,now);
        if (scalp && scalp.confidence >= setting(env.ADVISORY_MIN_CONFIDENCE,0.72,0.5,0.95)) candidates.push(scalp);
      }
    }`;
const newCandidateBuild = `    const beforeCount = candidates.length;
    const signal = analyse(sym, hist.get(sym) || [], now);
    const isCore = coreMarketSet.has(sym);
    const minimumConfidence = setting(env.ADVISORY_MIN_CONFIDENCE, 0.72, 0.5, 0.95);
    if (signal && signal.confidence >= minimumConfidence && (!isCore || signal.mode === "TREND_HOLD")) candidates.push(signal);
    else if (isCore) scanDiagnostics.push({symbol:sym,strategy:"TREND_HOLD",reason:signal ? "BELOW_CONFIDENCE_THRESHOLD" : "NO_VALID_TREND_SIGNAL"});
    if (isCore) {
      const candles = coreScalpData.get(sym);
      if (!candles || candles.one.length < 25 || candles.five.length < 30) {
        scanDiagnostics.push({symbol:sym,strategy:"CORE_PULLBACK_SCALP",reason:"INSUFFICIENT_CLOSED_CANDLE_HISTORY"});
      } else {
        const scalp = analyzeCorePullbackScalp(sym,candles.one,candles.five,now);
        if (scalp && scalp.confidence >= minimumConfidence) candidates.push(scalp);
        else scanDiagnostics.push({symbol:sym,strategy:"CORE_PULLBACK_SCALP",reason:"PULLBACK_RECLAIM_VOLUME_OR_FRESHNESS_GATE"});
      }
    }
    if (candidates.length === beforeCount) scanDiagnostics.push({symbol:sym,reason:"NO_QUALIFIED_CANDIDATE"});`;
once(oldCandidateBuild,newCandidateBuild,"expose independent trend and scalp rejection reasons");

once(
  '  candidates.sort((x, y) => eventIntel?.marketImpact === "BROAD_RISK_OFF" ? Number(y.side === "SHORT") - Number(x.side === "SHORT") || y.confidence - x.confidence : y.confidence - x.confidence);',
  '  const adaptiveLearning = buildAdaptiveLearningProfile(paperState?.trades || [], now);\n  for (const candidate of candidates) { candidate.adaptiveMultiplier=adaptiveCandidateMultiplier(adaptiveLearning,candidate); candidate.adaptiveScore=Number(candidate.confidence)*candidate.adaptiveMultiplier; }\n  if (paperStorage) { const priorLearning=await paperStorage.get("ciel:adaptive-learning:v1").catch(()=>null); if(priorLearning?.fingerprint!==adaptiveLearning.fingerprint) await paperStorage.put("ciel:adaptive-learning:v1",adaptiveLearning).catch((error)=>console.error("Adaptive paper-learning persistence failed: "+String(error).slice(0,160))); }\n  candidates.sort((x,y)=>Number(coreMarketSet.has(y.symbol))-Number(coreMarketSet.has(x.symbol)) || (eventIntel?.marketImpact==="BROAD_RISK_OFF"?Number(y.side==="SHORT")-Number(x.side==="SHORT"):0) || Number(y.adaptiveScore||y.confidence)-Number(x.adaptiveScore||x.confidence) || Number(y.confidence)-Number(x.confidence));',
  "prioritize core markets and apply learned outcome weights to ranking only"
);
once(
  '  await env.CIEL_STATE.put("ciel:advisor:last-scan", JSON.stringify({ at:now, watchCount:symbols.length, historySymbols:hist.size, candidates:candidates.map((x)=>({symbol:x.symbol,side:x.side,strategy:x.strategy,mode:x.mode,regime:x.regime,score:x.confidence,rsi:x.rsi,cci:x.cci})) }), { expirationTtl:86400 }).catch(()=>void 0);',
  '  await env.CIEL_STATE.put("ciel:advisor:last-scan", JSON.stringify({at:now,watchCount:symbols.length,historySymbols:hist.size,coreMarkets:["BTC","ETH","SOL"],adaptiveLearning:{closedTradeCount:adaptiveLearning.closedTradeCount,byStrategy:adaptiveLearning.byStrategy},scanDiagnostics:scanDiagnostics.slice(-120),candidates:candidates.map((x)=>({symbol:x.symbol,side:x.side,strategy:x.strategy,mode:x.mode,regime:x.regime,score:x.confidence,adaptiveScore:x.adaptiveScore,adaptiveMultiplier:x.adaptiveMultiplier,rsi:x.rsi,cci:x.cci}))}), {expirationTtl:86400}).catch(()=>void 0);',
  "persist bounded scan diagnostics and learning summary in existing KV state"
);
once(
  "  let forecastChecks = 0;\n  for (const candidate of candidates) {",
  '  let forecastChecks=0,coreForecastChecks=0,otherForecastChecks=0;\n  const hasCoreTrendCandidates=candidates.some((candidate)=>coreMarketSet.has(candidate.symbol)&&candidate.mode!=="RANGE_SCALP"&&candidate.mode!=="CORE_PULLBACK_SCALP");\n  for (const candidate of candidates) {',
  "reserve forecast-review capacity for other watchlist markets"
);
once(
  '    if (forecastChecks >= 6 && !isScalpMode) continue;\n    if (!isScalpMode) forecastChecks++;',
  '    if (!isScalpMode) { if(forecastChecks>=6) continue; if(hasCoreTrendCandidates&&coreMarketSet.has(candidate.symbol)&&coreForecastChecks>=3) continue; if(hasCoreTrendCandidates&&!coreMarketSet.has(candidate.symbol)&&otherForecastChecks>=3) continue; forecastChecks++; if(coreMarketSet.has(candidate.symbol))coreForecastChecks++; else otherForecastChecks++; }',
  "cap core trend reviews at three so other coins retain review capacity"
);

await writeFile(file,source);
console.log("Adaptive core-market patch complete: BTC/ETH/SOL lead the scan, all other configured markets remain eligible, paper outcomes adjust ranking only after eight closed samples, and no D1 writes or risk-limit changes are introduced.");
