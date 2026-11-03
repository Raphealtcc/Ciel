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
once(signature,learningHelpers+"\nfunction analyzeCoreTrendContinuation(symbol, fiveMinuteRows, now) {\n  const rows=(Array.isArray(fiveMinuteRows)?fiveMinuteRows:[]).map(row=>({\n    t:Number(row.close_ts_ms||row.open_ts_ms+300e3),o:Number(row.open_price),h:Number(row.high_price),\n    l:Number(row.low_price),c:Number(row.close_price),v:Number(row.volume)||0\n  })).filter(c=>c.t>0&&[c.o,c.h,c.l,c.c].every(v=>Number.isFinite(v)&&v>0)).sort((a,b)=>a.t-b.t);\n  if(rows.length<40)return null;\n  const last=rows[rows.length-1],breakout=rows[rows.length-2];\n  if(now-last.t>7*60e3||last.t>now+15e3)return null;\n  const ema=(values,period)=>{if(values.length<period)return NaN;const k=2/(period+1);let v=values[0];for(let i=1;i<values.length;i++)v=values[i]*k+v*(1-k);return v;};\n  const closes=rows.map(c=>c.c),fast=ema(closes.slice(-30),9),slow=ema(closes.slice(-30),21),priorFast=ema(closes.slice(-31,-1),9);\n  if(![fast,slow,priorFast].every(Number.isFinite))return null;\n  const atrRows=rows.slice(-15),atr=atrRows.reduce((s,c)=>s+c.h-c.l,0)/atrRows.length;\n  if(!(atr>0))return null;\n  const base=rows.slice(-25,-5),resistance=Math.max(...base.map(c=>c.h)),support=Math.min(...base.map(c=>c.l));\n  const avgVol=rows.slice(-21,-1).reduce((s,c)=>s+c.v,0)/20;\n  if(avgVol>0&&last.v<avgVol*0.8)return null;\n  let side=null,pivot=0,level=0;\n  if(fast>slow&&fast>priorFast&&breakout.c>resistance+atr*0.05&&last.l<=resistance+atr*0.2&&last.l>=resistance-atr*0.35&&last.c>resistance&&last.c>last.o){\n    side=\"LONG\";level=resistance;pivot=Math.min(last.l,breakout.l);\n  } else if(fast<slow&&fast<priorFast&&breakout.c<support-atr*0.05&&last.h>=support-atr*0.2&&last.h<=support+atr*0.35&&last.c<support&&last.c<last.o){\n    side=\"SHORT\";level=support;pivot=Math.max(last.h,breakout.h);\n  }\n  if(!side)return null;\n  const raw=side===\"LONG\"?(last.c-pivot+atr*0.1)/last.c*100:(pivot-last.c+atr*0.1)/last.c*100;\n  const stopPct=Math.max(0.12,raw);\n  if(!(stopPct<=0.45))return null;\n  const targetPct=Math.max(0.3,stopPct*1.8);\n  const confidence=Math.min(0.86,0.75+Math.min(0.06,Math.abs(last.c-last.o)/last.c*0.1)+(avgVol<=0||last.v>=avgVol?0.02:0));\n  return {symbol,side,entry:last.c,stopPct,targetPct,confidence,scoreComponents:[\"5M_EMA_TREND\",\"5M_RANGE_BREAKOUT\",\"5M_BREAKOUT_RETEST\",\"VOLUME_CONFIRMATION\"],scoreModel:\"core-5m-breakout-retest-v1\",strategy:\"5M_TREND_CONTINUATION+BREAKOUT_RETEST\",regime:side===\"LONG\"?\"TREND_UP\":\"TREND_DOWN\",mode:\"CORE_TREND_CONTINUATION\",holdMinutes:60,rsi:null,bounce:null,cci:null,stochRsi:null,rangePositionPct:null,reason:\"Closed 5m candles confirm EMA9/EMA21 trend, a prior 20-candle range breakout, and a retest that holds the broken level with volume confirmation.\"};\n}\n__name(analyzeCoreTrendContinuation,\"analyzeCoreTrendContinuation\");\n"+signature,"add bounded paper learning and 5m trend-continuation helpers");

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
      if (!candles || candles.one.length < 25 || candles.five.length < 40) {
        scanDiagnostics.push({symbol:sym,strategy:"CORE_PULLBACK_SCALP",reason:"INSUFFICIENT_CLOSED_CANDLE_HISTORY"});
        scanDiagnostics.push({symbol:sym,strategy:"CORE_TREND_CONTINUATION",reason:"INSUFFICIENT_CLOSED_5M_HISTORY"});
      } else {
        const scalp = analyzeCorePullbackScalp(sym,candles.one,candles.five,now);
        if (scalp && scalp.confidence >= minimumConfidence) candidates.push(scalp);
        else scanDiagnostics.push({symbol:sym,strategy:"CORE_PULLBACK_SCALP",reason:"PULLBACK_RECLAIM_VOLUME_OR_FRESHNESS_GATE"});
        const continuation = analyzeCoreTrendContinuation(sym,candles.five,now);
        if (continuation && continuation.confidence >= minimumConfidence) candidates.push(continuation);
        else scanDiagnostics.push({symbol:sym,strategy:"CORE_TREND_CONTINUATION",reason:"EMA_BREAKOUT_RETEST_VOLUME_OR_FRESHNESS_GATE"});
      }
    }
    if (candidates.length === beforeCount) scanDiagnostics.push({symbol:sym,reason:"NO_QUALIFIED_CANDIDATE"});`;
once(oldCandidateBuild,newCandidateBuild,"expose independent trend and scalp rejection reasons");

once(
  '  candidates.sort((x, y) => eventIntel?.marketImpact === "BROAD_RISK_OFF" ? Number(y.side === "SHORT") - Number(x.side === "SHORT") || y.confidence - x.confidence : y.confidence - x.confidence);',
  '  const adaptiveLearning = buildAdaptiveLearningProfile(paperState?.trades || [], now);\n  for (const candidate of candidates) { candidate.adaptiveMultiplier=adaptiveCandidateMultiplier(adaptiveLearning,candidate); candidate.adaptiveScore=Number(candidate.confidence)*candidate.adaptiveMultiplier; }\n  if (paperStorage) { const priorLearning=await paperStorage.get("ciel:adaptive-learning:v1").catch(()=>null); if(priorLearning?.fingerprint!==adaptiveLearning.fingerprint) await paperStorage.put("ciel:adaptive-learning:v1",adaptiveLearning).catch((error)=>console.error("Adaptive paper-learning persistence failed: "+String(error).slice(0,160))); }\n  const preferredGroup = Math.floor(now / CYCLE) % 3 === 2 ? "WATCHLIST" : "CORE";\n  candidates.sort((x,y)=>Number((coreMarketSet.has(y.symbol)===(preferredGroup==="CORE")))-Number((coreMarketSet.has(x.symbol)===(preferredGroup==="CORE"))) || (eventIntel?.marketImpact==="BROAD_RISK_OFF"?Number(y.side==="SHORT")-Number(x.side==="SHORT"):0) || Number(y.adaptiveScore||y.confidence)-Number(x.adaptiveScore||x.confidence) || Number(y.confidence)-Number(x.confidence));',
  "prioritize core markets and apply learned outcome weights to ranking only"
);
once(
  '  await env.CIEL_STATE.put("ciel:advisor:last-scan", JSON.stringify({ at:now, watchCount:symbols.length, historySymbols:hist.size, candidates:candidates.map((x)=>({symbol:x.symbol,side:x.side,strategy:x.strategy,mode:x.mode,regime:x.regime,score:x.confidence,rsi:x.rsi,cci:x.cci})) }), { expirationTtl:86400 }).catch(()=>void 0);',
  '  await env.CIEL_STATE.put("ciel:advisor:last-scan", JSON.stringify({at:now,watchCount:symbols.length,historySymbols:hist.size,coreMarkets:["BTC","ETH","SOL"],preferredGroup,adaptiveLearning:{closedTradeCount:adaptiveLearning.closedTradeCount,byStrategy:adaptiveLearning.byStrategy},scanDiagnostics:scanDiagnostics.slice(-120),candidates:candidates.map((x)=>({symbol:x.symbol,side:x.side,strategy:x.strategy,mode:x.mode,regime:x.regime,score:x.confidence,adaptiveScore:x.adaptiveScore,adaptiveMultiplier:x.adaptiveMultiplier,rsi:x.rsi,cci:x.cci}))}), {expirationTtl:86400}).catch(()=>void 0);',
  "persist bounded scan diagnostics and learning summary in existing KV state"
);
once(
  "  let forecastChecks = 0;\n  for (const candidate of candidates) {",
  '  let forecastChecks=0,coreForecastChecks=0,otherForecastChecks=0;\n  const coreTrendCandidateCount=candidates.filter((candidate)=>coreMarketSet.has(candidate.symbol)&&candidate.mode!=="RANGE_SCALP"&&candidate.mode!=="CORE_PULLBACK_SCALP").length;\n  for (const candidate of candidates) {',
  "reserve forecast-review capacity for other watchlist markets"
);
once(
  '    if (forecastChecks >= 6 && !isScalpMode) continue;\n    if (!isScalpMode) forecastChecks++;',
  '    if (!isScalpMode) { if(forecastChecks>=6) continue; if(coreTrendCandidateCount>0&&coreMarketSet.has(candidate.symbol)&&coreForecastChecks>=Math.min(3,coreTrendCandidateCount)) continue; if(coreTrendCandidateCount>0&&!coreMarketSet.has(candidate.symbol)&&otherForecastChecks>=6-Math.min(3,coreTrendCandidateCount)) continue; forecastChecks++; if(coreMarketSet.has(candidate.symbol))coreForecastChecks++; else otherForecastChecks++; }',
  "cap core trend reviews at three so other coins retain review capacity"
);

once(
  'const marker = await env.CIEL_STATE.get("ciel:telegram:webhook:auto-registration").catch(() => null);',
  'const marker = await env.CIEL_STATE.get("ciel:telegram:webhook:auto-registration").catch(() => null);\n        const advisorScanRaw = await env.CIEL_STATE.get("ciel:advisor:last-scan").catch(() => null);\n        let advisorScan = null; try { advisorScan = advisorScanRaw ? JSON.parse(advisorScanRaw) : null; } catch { advisorScan = null; }',
  "expose the latest advisor scan through protected diagnostics",
);
once(
  'telegramWebhookRegistrationMarkerPresent: Boolean(marker), feed:',
  'telegramWebhookRegistrationMarkerPresent: Boolean(marker), advisorScan, feed:',
  "include strategy rejection and adaptive-learning summaries in diagnostics",
);

once("const strategyStats = { rangeScalp: modeStats(\"RANGE_SCALP\"), trendHold: modeStats(\"TREND_HOLD\"), legacy: modeStats(\"LEGACY\") };","const strategyStats = { corePullbackScalp: modeStats(\"CORE_PULLBACK_SCALP\"), coreTrendContinuation: modeStats(\"CORE_TREND_CONTINUATION\"), trendHold: modeStats(\"TREND_HOLD\"), rangeScalp: modeStats(\"RANGE_SCALP\"), legacy: modeStats(\"LEGACY\") };","report CORE_PULLBACK_SCALP, CORE_TREND_CONTINUATION, TREND_HOLD and RANGE_SCALP separately");

await writeFile(file,source);
console.log("Adaptive core-market patch complete: BTC/ETH/SOL lead the scan, all other configured markets remain eligible, paper outcomes adjust ranking only after eight closed samples, and no D1 writes or risk-limit changes are introduced.");
