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
  const closed = (Array.isArray(trades) ? trades : []).filter((trade) => trade && trade.status === "CLOSED" && trade.feeModelVersion !== "LEGACY_FEE_DATA_UNAVAILABLE" && trade.netPnlMon !== null && trade.netPnlMon !== undefined && Number.isFinite(Number(trade.closedAtMs)) && now - Number(trade.closedAtMs) <= 90 * 86400000).sort((a, b) => Number(a.closedAtMs) - Number(b.closedAtMs)).slice(-300);
  const buckets = new Map();
  const add = (key, trade) => { if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(trade); };
  for (const trade of closed) {
    const symbol = String(trade.symbol || "UNKNOWN").toUpperCase(), mode = String(trade.mode || "LEGACY").toUpperCase(), strategy = String(trade.strategy || mode).toUpperCase(), side = String(trade.side || "UNKNOWN").toUpperCase(), regime = String(trade.regime || "UNKNOWN").toUpperCase();
    add("mode:" + mode, trade); add("strategy:" + strategy, trade); add("market:" + symbol + "|" + strategy, trade); add("symbol:" + symbol, trade); add("side:" + side, trade); add("regime:" + regime, trade);
  }
  const summarize = (rows) => {
    const count = rows.length, wins = rows.filter((trade) => Number(trade.netPnlMon ?? trade.grossPnlMon ?? trade.pnlMon ?? 0) > 0).length;
    const realizedPnlMon = rows.reduce((sum, trade) => sum + (Number(trade.netPnlMon ?? trade.grossPnlMon ?? trade.pnlMon) || 0), 0), totalMarginMon = rows.reduce((sum, trade) => sum + Math.max(0, Number(trade.marginMon) || 0), 0);
    const expectancyPct = totalMarginMon > 0 ? realizedPnlMon / totalMarginMon * 100 : 0, smoothedWinRate = (wins + 2) / (count + 4), sampleWeight = Math.min(1, count / 20);
    const winAdjustment = Math.max(-0.06, Math.min(0.06, (smoothedWinRate - 0.5) * 0.16)), expectancyAdjustment = Math.max(-0.20, Math.min(0.20, expectancyPct * 0.06));
    const multiplier = count < 8 ? 1 : Math.max(0.70, Math.min(1.30, 1 + (winAdjustment + expectancyAdjustment) * sampleWeight));
    const closeReasons = {}; for (const trade of rows) { const reason = String(trade.closeReason || "UNKNOWN"); closeReasons[reason] = (closeReasons[reason] || 0) + 1; }
    return { trades: count, wins, losses: count - wins, winRate: count ? wins / count : 0, realizedPnlMon: Number(realizedPnlMon.toFixed(6)), totalMarginMon: Number(totalMarginMon.toFixed(6)), expectancyPct: Number(expectancyPct.toFixed(6)), multiplier: Number(multiplier.toFixed(6)), avgBestFavorableMovePct: count ? rows.reduce((sum, trade) => sum + (Number(trade.bestFavorableMovePct) || 0), 0) / count : 0, closeReasons };
  };
  const byStrategy = {}, bySymbolStrategy = {}, bySymbol = {}, byMode = {}, bySide = {}, byRegime = {};
  for (const [key, rows] of buckets) { const summary = summarize(key.startsWith("side:") || key.startsWith("regime:") ? rows.slice(-60) : rows.slice(-40)); if (key.startsWith("strategy:")) byStrategy[key.slice(9)] = summary; else if (key.startsWith("market:")) bySymbolStrategy[key.slice(7)] = summary; else if (key.startsWith("symbol:")) bySymbol[key.slice(7)] = summary; else if (key.startsWith("mode:")) byMode[key.slice(5)] = summary; else if (key.startsWith("side:")) bySide[key.slice(5)] = summary; else if (key.startsWith("regime:")) byRegime[key.slice(7)] = summary; }
  const latest = closed[closed.length - 1], fingerprint = closed.length + ":" + String(latest?.closedAtMs || 0) + ":" + String(latest?.signalId || "");
  return { version: 3, updatedAtMs: now, sampleWindowDays: 90, closedTradeCount: closed.length, fingerprint, byStrategy, bySymbolStrategy, bySymbol, byMode, bySide, byRegime };
}
__name(buildAdaptiveLearningProfile, "buildAdaptiveLearningProfile");
function adaptiveCandidateMultiplier(profile, candidate) {
  const symbol = String(candidate?.symbol || "").toUpperCase(), mode = String(candidate?.mode || "LEGACY").toUpperCase(), strategy = String(candidate?.strategy || mode).toUpperCase(), side = String(candidate?.side || "UNKNOWN").toUpperCase(), regime = String(candidate?.regime || "UNKNOWN").toUpperCase();
  const specific = profile?.bySymbolStrategy?.[symbol + "|" + strategy], marketStats = profile?.bySymbol?.[symbol], strategyStats = profile?.byStrategy?.[strategy], modeStats = profile?.byMode?.[mode];
  const selected = specific && specific.trades >= 8 ? specific : strategyStats && strategyStats.trades >= 8 ? strategyStats : modeStats, factors = [];
  if (marketStats && marketStats.trades >= 8) factors.push(Number(marketStats.multiplier) || 1);\n  if (selected && selected.trades >= 8) factors.push(Number(selected.multiplier) || 1);
  const sideStats = profile?.bySide?.[side]; if (sideStats && sideStats.trades >= 8) factors.push(Number(sideStats.multiplier) || 1);
  const regimeStats = profile?.byRegime?.[regime]; if (regimeStats && regimeStats.trades >= 8) factors.push(Number(regimeStats.multiplier) || 1);
  return Math.max(0.70, Math.min(1.30, factors.reduce((product, factor) => product * factor, 1)));
}
__name(adaptiveCandidateMultiplier, "adaptiveCandidateMultiplier");
function adaptiveStrategyPriority(candidate) {
  const strategy = String(candidate?.strategy || "").toUpperCase();
  // Ranking preference only: retain all seven markets and all valid strategies.
  if (strategy === "5M_TREND_CONTINUATION+BREAKOUT_RETEST") return 0.14;
  if (strategy === "5M_TREND+1M_PULLBACK+RECLAIM") return 0.10;
  if (strategy === "5M_STRUCTURE+EMA+MACD+RSI+BREAKOUT_RETEST") return 0.08;
  if (strategy === "MULTI_MARKET_LEVEL_SWEEP_RECLAIM") return -0.06;
  if (strategy === "1M_MICRO_MOMENTUM_BREAKOUT") return -0.10;
  if (strategy === "1M_SWING_REVERSAL+RECLAIM") return -0.06;
  return 0;
}
__name(adaptiveStrategyPriority, "adaptiveStrategyPriority");
`;;
const signature="async function runAdvisorCycle(env, prices, now, lastTickAt, priceHistory, liveEvidence, paperStorage, coreScalpCandles = {}, coreTrendCandles = {}) {";
once(signature,learningHelpers+"\nfunction analyzeCoreTrendContinuation(symbol, fiveMinuteRows, now) {\n  const rows=(Array.isArray(fiveMinuteRows)?fiveMinuteRows:[]).map(row=>({\n    t:Number(row.close_ts_ms||row.open_ts_ms+300e3),o:Number(row.open_price),h:Number(row.high_price),\n    l:Number(row.low_price),c:Number(row.close_price),v:Number(row.volume)||0\n  })).filter(c=>c.t>0&&[c.o,c.h,c.l,c.c].every(v=>Number.isFinite(v)&&v>0)).sort((a,b)=>a.t-b.t);\n  if(rows.length<40)return null;\n  const last=rows[rows.length-1],breakout=rows[rows.length-2];\n  if(now-last.t>7*60e3||last.t>now+15e3)return null;\n  const ema=(values,period)=>{if(values.length<period)return NaN;const k=2/(period+1);let v=values[0];for(let i=1;i<values.length;i++)v=values[i]*k+v*(1-k);return v;};\n  const closes=rows.map(c=>c.c),fast=ema(closes.slice(-30),9),slow=ema(closes.slice(-30),21),priorFast=ema(closes.slice(-31,-1),9);\n  if(![fast,slow,priorFast].every(Number.isFinite))return null;\n  const atrRows=rows.slice(-15),atr=atrRows.reduce((s,c)=>s+c.h-c.l,0)/atrRows.length;\n  if(!(atr>0))return null;\n  const base=rows.slice(-25,-5),resistance=Math.max(...base.map(c=>c.h)),support=Math.min(...base.map(c=>c.l));\n  const avgVol=rows.slice(-21,-1).reduce((s,c)=>s+c.v,0)/20;\n  if(avgVol>0&&last.v<avgVol*0.65)return null;\n  let side=null,pivot=0,level=0;\n  if(fast>slow&&fast>priorFast&&breakout.c>resistance+atr*0.05&&last.l<=resistance+atr*0.35&&last.l>=resistance-atr*0.35&&last.c>resistance&&last.c>last.o){\n    side=\"LONG\";level=resistance;pivot=Math.min(last.l,breakout.l);\n  } else if(fast<slow&&fast<priorFast&&breakout.c<support-atr*0.05&&last.h>=support-atr*0.35&&last.h<=support+atr*0.35&&last.c<support&&last.c<last.o){\n    side=\"SHORT\";level=support;pivot=Math.max(last.h,breakout.h);\n  }\n  if(!side)return null;\n  const raw=side===\"LONG\"?(last.c-pivot+atr*0.1)/last.c*100:(pivot-last.c+atr*0.1)/last.c*100;\n  const stopPct=Math.max(0.12,raw);\n  if(!(stopPct<=0.45))return null;\n  const targetPct=Math.max(0.3,stopPct*1.8);\n  const confidence=Math.min(0.86,0.75+Math.min(0.06,Math.abs(last.c-last.o)/last.c*0.1)+(avgVol<=0||last.v>=avgVol?0.02:0));\n  return {symbol,side,entry:last.c,stopPct,targetPct,confidence,scoreComponents:[\"5M_EMA_TREND\",\"5M_RANGE_BREAKOUT\",\"5M_BREAKOUT_RETEST\",\"VOLUME_CONFIRMATION\"],scoreModel:\"core-5m-breakout-retest-v1\",strategy:\"5M_TREND_CONTINUATION+BREAKOUT_RETEST\",regime:side===\"LONG\"?\"TREND_UP\":\"TREND_DOWN\",mode:\"TREND_HOLD\",holdMinutes:180,rsi:null,bounce:null,cci:null,stochRsi:null,rangePositionPct:null,reason:\"Closed 5m candles confirm EMA9/EMA21 trend, a prior 20-candle range breakout, and a retest that holds the broken level with volume confirmation.\"};\n}\n__name(analyzeCoreTrendContinuation,\"analyzeCoreTrendContinuation\");\n"+signature,"add bounded paper learning and 5m trend-continuation helpers");

once(
  "  const symbols = configuredWatchSymbols(env.WATCH_SYMBOLS);",
  '  const symbols = [...new Set(["BTC","ETH","SOL","BNB","HYPE","ADA","PUMP", ...configuredWatchSymbols(env.WATCH_SYMBOLS)])];',
  "keep BTC ETH SOL in the scan even when WATCH_SYMBOLS omits them"
);
once(
  "  const candidates = [];\n  for (const sym of symbols) {",
  '  const candidates = [];\n  const scanDiagnostics = [];\n  const coreMarketSet = new Set(["BTC","ETH","SOL"]);\n  const trendEntryMarketSet = new Set(["BTC","ETH","SOL","BNB","HYPE","ADA","PUMP"]);\n  const orderedSymbols = symbols.slice().sort((a,b) => Number(coreMarketSet.has(b))-Number(coreMarketSet.has(a)) || a.localeCompare(b));\n  for (const sym of orderedSymbols) {',
  "evaluate core markets first without removing other watchlist markets"
);
once(
  '    if (sym === "MON" || requiredPaperMargin === null || paperCash + 1e-9 < requiredPaperMargin || openPaperSymbols.has(sym)) continue;',
  '    if (sym === "MON") { scanDiagnostics.push({symbol:sym,reason:"NON_TRADEABLE_BASE_ASSET"}); continue; }\n    if (requiredPaperMargin === null) { scanDiagnostics.push({symbol:sym,reason:"BELOW_50X_OR_UNSUPPORTED_LEVERAGE_TIER"}); continue; }\n    if (paperCash + 1e-9 < requiredPaperMargin) { scanDiagnostics.push({symbol:sym,reason:"INSUFFICIENT_FREE_MARGIN",requiredPaperMargin,availablePaperMargin:paperCash}); continue; }\n    if (openPaperSymbols.has(sym)) { scanDiagnostics.push({symbol:sym,reason:"POSITION_ALREADY_OPEN"}); continue; }',
  "record eligibility, margin and open-position rejection reasons"
);

const oldCandidateBuild = `    const signal = analyzeCandleLevelReversal(sym,marketRows,candleStructureRows.get(sym),now) || analyse(sym,marketRows,now);
    const isCore = ["BTC","ETH","SOL"].includes(sym);
    if (signal && signal.confidence >= setting(env.ADVISORY_MIN_CONFIDENCE, 0.72, 0.5, 0.95) && (!isCore || signal.mode === "TREND_HOLD")) candidates.push(signal);
    if (isCore) {
      const candles = coreScalpData.get(sym);
      if (candles) {
        const scalp = analyzeTrendPullbackEntry(sym,candles.one,candles.five,now);
        if (scalp && scalp.confidence >= setting(env.ADVISORY_MIN_CONFIDENCE,0.72,0.5,0.95)) candidates.push(scalp);
      }
    }`;
const newCandidateBuild = `    const beforeCount = candidates.length;
    const baseSignals = [analyzeCandleLevelReversal(sym,marketRows,candleStructureRows.get(sym),now), analyse(sym,marketRows,now)];
    const confidenceFloor = setting(env.ADVISORY_MIN_CONFIDENCE,0.72,0.5,0.95);
    const isCore = coreMarketSet.has(sym);
    const isTrendEligible = trendEntryMarketSet.has(sym);
    const signal = baseSignals.find((item) => item && (!isCore || item.mode === "TREND_HOLD"));
    if (signal && signal.confidence >= confidenceFloor && (!isCore || signal.mode === "TREND_HOLD")) candidates.push(signal);
    for (const alternateSignal of baseSignals) {
      if (alternateSignal && alternateSignal !== signal && (!isCore || alternateSignal.mode === "TREND_HOLD")) candidates.push(alternateSignal);
    }
    if (isCore && !signal && !baseSignals.some((item) => item && item.mode === "TREND_HOLD")) scanDiagnostics.push({symbol:sym,strategy:"TREND_HOLD",reason:baseSignals.some(Boolean) ? "NO_CORE_TREND_MODE" : "NO_VALID_TREND_SIGNAL"});
    if (isTrendEligible) {
      const candles = coreScalpData.get(sym);
      if (!candles || candles.one.length < 25 || candles.five.length < 40) {
        scanDiagnostics.push({symbol:sym,strategy:"TREND_PULLBACK_ENTRY",reason:"INSUFFICIENT_CLOSED_CANDLE_HISTORY"});
      } else {
        const scalp = analyzeTrendPullbackEntry(sym,candles.one,candles.five,now);
        if (scalp) candidates.push(scalp);
        else scanDiagnostics.push({symbol:sym,strategy:"TREND_PULLBACK_ENTRY",reason:"PULLBACK_RECLAIM_VOLUME_OR_FRESHNESS_GATE"});
      }
      if (!candles || candles.five.length < 40) {
        scanDiagnostics.push({symbol:sym,strategy:"TREND_BREAKOUT_RETEST",reason:"INSUFFICIENT_CLOSED_5M_HISTORY"});
      } else {
        const continuation = analyzeCoreTrendContinuation(sym,candles.five,now);
        if (continuation) candidates.push(continuation);
        else scanDiagnostics.push({symbol:sym,strategy:"TREND_BREAKOUT_RETEST",reason:"EMA_BREAKOUT_RETEST_VOLUME_OR_FRESHNESS_GATE"});
      }
    }
    if (candidates.length === beforeCount) scanDiagnostics.push({symbol:sym,reason:"NO_QUALIFIED_CANDIDATE"});`;
once(oldCandidateBuild,newCandidateBuild,"expose independent trend and scalp rejection reasons");

once(
  '      const aligned = candidate.side === "LONG" ? Number(forecast.medianReturnPct) >= minimumForecastMovePct : Number(forecast.medianReturnPct) <= -minimumForecastMovePct;\n      if (!aligned && candidate.mode !== "RANGE_SCALP" && !String(candidate.strategy || "").includes("1M_SWING_REVERSAL")) {',
  'if (stronglyOpposed && candidate.mode === "TREND_HOLD" && !String(candidate.strategy || "").includes("1M_SWING_REVERSAL")) {',
  "block materially opposing forecasts while exempting validated core scalps"
);
once(
  'const minimumForecastMovePct = Math.max(0.08, candidate.stopPct * 0.30);',
  'const minimumForecastMovePct = Math.max(0.03, candidate.stopPct * 0.10);\n      const stronglyOpposed = candidate.side === "LONG" ? Number(forecast.medianReturnPct) <= -minimumForecastMovePct : Number(forecast.medianReturnPct) >= minimumForecastMovePct;',
  "block materially opposing forecasts, not technically valid scalps with a neutral or small same-direction projection"
);
once(
  'const extremeExhaustion = (candidate.side === "SHORT" && Number.isFinite(candidate.rsi) && candidate.rsi < 20 && candidate.bounce?.side !== "SHORT") || (candidate.side === "LONG" && Number.isFinite(candidate.rsi) && candidate.rsi > 80 && candidate.bounce?.side !== "LONG");',
  'const extremeExhaustion = (candidate.side === "SHORT" && Number.isFinite(candidate.rsi) && candidate.rsi < 10 && candidate.bounce?.side !== "SHORT") || (candidate.side === "LONG" && Number.isFinite(candidate.rsi) && candidate.rsi > 90 && candidate.bounce?.side !== "LONG");',
  "reserve the momentum-exhaustion veto for genuinely extreme RSI readings"
);


once(
  '  candidates.sort((x, y) => eventIntel?.marketImpact === "BROAD_RISK_OFF" ? Number(y.side === "SHORT") - Number(x.side === "SHORT") || y.confidence - x.confidence : y.confidence - x.confidence);',
  '  const adaptiveLearning = buildAdaptiveLearningProfile(paperState?.trades || [], now);\n  for (const candidate of candidates) { candidate.adaptiveMultiplier=adaptiveCandidateMultiplier(adaptiveLearning,candidate); candidate.strategyPriority=adaptiveStrategyPriority(candidate); candidate.adaptiveScore=Number(candidate.confidence)*candidate.adaptiveMultiplier+candidate.strategyPriority; }\n  if (paperStorage) { const priorLearning=await paperStorage.get("ciel:adaptive-learning:v2").catch(()=>null); if(priorLearning?.fingerprint!==adaptiveLearning.fingerprint) await paperStorage.put("ciel:adaptive-learning:v2",adaptiveLearning).catch((error)=>console.error("Adaptive paper-learning persistence failed: "+String(error).slice(0,160))); }\n  const preferredGroup = Math.floor(now / (5 * 60e3)) % 3 === 2 ? "WATCHLIST" : "CORE";\n  candidates.sort((x,y)=>Number((coreMarketSet.has(y.symbol)===(preferredGroup==="CORE")))-Number((coreMarketSet.has(x.symbol)===(preferredGroup==="CORE"))) || Number(y.adaptiveScore||y.confidence)-Number(x.adaptiveScore||x.confidence) || (eventIntel?.marketImpact==="BROAD_RISK_OFF"?Number(y.side==="SHORT")-Number(x.side==="SHORT"):0) || Number(y.confidence)-Number(x.confidence));',
  "prioritize core markets and apply learned outcome weights to ranking only"
);
once(
  "  let forecastChecks = 0;\n  for (const candidate of candidates) {",
  "  const candidateSymbols = new Set(candidates.map((x) => x.symbol));\n  const noSetupSymbols = symbols.filter((symbol) => symbol !== \"MON\" && !candidateSymbols.has(symbol));\n  const scanSnapshot = {at:now,scanStatus:candidates.length ? \"CANDIDATES_FOUND\" : \"NO_TECHNICAL_SETUP\",watchCount:symbols.length,scannedSymbols:symbols.filter((symbol) => symbol !== \"MON\"),historySymbols:hist.size,candleLevelSymbols:candleStructureRows.size,coreMarkets:[\"BTC\",\"ETH\",\"SOL\"],trendEntryMarkets:[\"BTC\",\"ETH\",\"SOL\",\"BNB\",\"HYPE\",\"ADA\",\"PUMP\"],preferredGroup,adaptiveLearning:{closedTradeCount:adaptiveLearning.closedTradeCount,byStrategy:adaptiveLearning.byStrategy},candidateCount:candidates.length,noSetupSymbols,scanDiagnostics:scanDiagnostics.slice(-120),candidates:candidates.map((x)=>({symbol:x.symbol,side:x.side,strategy:x.strategy,mode:x.mode,regime:x.regime,score:x.confidence,adaptiveScore:x.adaptiveScore,adaptiveMultiplier:x.adaptiveMultiplier,strategyPriority:x.strategyPriority,rsi:x.rsi,cci:x.cci}))};\n  for (const rejection of scanDiagnostics.slice(-30)) console.info(\"CIEL_ADVISOR_REJECT \" + JSON.stringify(rejection));\n  await env.CIEL_STATE.put(\"ciel:advisor:last-scan\", JSON.stringify(scanSnapshot), {expirationTtl:86400}).catch(()=>void 0);\n  console.info(\"CIEL_ADVISOR_SCAN \" + JSON.stringify({at:now,scanStatus:scanSnapshot.scanStatus,watchCount:scanSnapshot.watchCount,candidateCount:scanSnapshot.candidateCount,noSetupSymbols:scanSnapshot.noSetupSymbols,diagnosticCount:scanDiagnostics.length}));\n  let forecastChecks=0,coreForecastChecks=0,otherForecastChecks=0;\n  let liveEntrySubmittedThisCycle=false,proposalCountThisCycle=0;\n  const maxProposalsPerCycle=3;\n  const coreTrendCandidateCount=candidates.filter((candidate)=>coreMarketSet.has(candidate.symbol)&&candidate.mode!==\"RANGE_SCALP\"&&candidate.mode!==\"TREND_PULLBACK_ENTRY\").length;\n  for (const candidate of candidates) {",
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
  'telegramWebhookRegistrationMarkerPresent: Boolean(marker)',
  'telegramWebhookRegistrationMarkerPresent: Boolean(marker), advisorScan',
  "include strategy rejection and adaptive-learning summaries in diagnostics",
);

once("const strategyStats = { rangeScalp: modeStats(\"RANGE_SCALP\"), trendHold: modeStats(\"TREND_HOLD\"), legacy: modeStats(\"LEGACY\") };","const strategyStats = { trendHold: modeStats(\"TREND_HOLD\") };","report only the active TREND_HOLD strategy");

once("lines.push(\"\", \"STRATEGY PERFORMANCE (CLOSED PAPER TRADES)\", \"Range scalps: \" + describeMode(data.strategyStats.rangeScalp), \"Trend holds: \" + describeMode(data.strategyStats.trendHold));","lines.push(\"\", \"STRATEGY PERFORMANCE (CLOSED PAPER TRADES)\", \"Trend holds: \" + describeMode(data.strategyStats.trendHold));","print only active trend-hold performance in /profits");
once(
  'const reviewed = candidate.strategy === "5M_TREND+1M_PULLBACK+RECLAIM"',
  'const reviewed = candidate.strategy === "5M_TREND_CONTINUATION+BREAKOUT_RETEST"\n      ? { verdict:"WAIT", reason:"Closed 5m EMA trend, breakout, retest, volume, freshness and market-quality gates passed; deterministic continuation review avoids duplicate Gemini calls.", flags:["LOCAL_TREND_BREAKOUT_RETEST"], model:"CIEL deterministic trend continuation guard", queries:[], sources:[] }\n      : candidate.strategy === "5M_TREND+1M_PULLBACK+RECLAIM"',
  "use deterministic local review for validated trend continuation and pullback candidates",
);
once(
  '"LOCAL_RANGE_SCALP_REVIEW", "LOCAL_TREND_PULLBACK_ENTRY"',
  '"LOCAL_RANGE_SCALP_REVIEW", "LOCAL_TREND_PULLBACK_ENTRY", "LOCAL_TREND_BREAKOUT_RETEST"',
  "allow the deterministic continuation review through existing forecast and market-quality gates",
);
once(
  '!["CIEL deterministic range guard","CIEL deterministic trend pullback guard"].includes(reviewed.model)',
  '!["CIEL deterministic range guard","CIEL deterministic trend pullback guard","CIEL deterministic trend continuation guard"].includes(reviewed.model)',
  "mark 5m continuation as deterministic technical confirmation rather than missing AI confirmation",
);


function patchGeminiMultiProjectFailover() {
  const replaceOnce = (before, after, label) => {
    const count = source.split(before).length - 1;
    if (count !== 1) throw new Error("Gemini failover patch " + label + ": expected one match, found " + count);
    source = source.replace(before, after);
  };
  const cooldownGuard = /if\s*\(\s*Number\(cooldown\.untilMs\)\s*>\s*Date\.now\(\)\s*\)\s*\{/;
  const allKeysGuard = /if\s*\(\s*cooldown\.allKeysFailed\s*===\s*true\s*&&\s*Number\(cooldown\.untilMs\)\s*>\s*Date\.now\(\)\s*\)\s*\{/;
  if (cooldownGuard.test(source)) {
    source = source.replace(cooldownGuard, "if (cooldown.allKeysFailed === true && Number(cooldown.untilMs) > Date.now()) {");
  } else if (!allKeysGuard.test(source)) {
    throw new Error("Gemini failover patch only honor cooldown after all keys fail: cooldown guard not found; context=" + source.slice(Math.max(0, source.indexOf("cooldownKey") - 120), source.indexOf("cooldownKey") + 700));
  }
  replaceOnce("for (let i = 0; i < keys.length && transientAttempts < 2; i++) {",
    "for (let i = 0; i < keys.length; i++) {", "attempt every configured key");
  replaceOnce("let transientAttempts = 0;",
    'let quotaFailures = 0, maxRetryAt = 0, lastFailure = "Gemini request failed."; ',
    "track all-key failure state");
  const start = source.indexOf("if (r.status === 429) {", source.indexOf("for (let i = 0; i < keys.length; i++) {"));
  const end = source.indexOf("const data = await r.json();", start);
  if (start < 0 || end < 0) throw new Error("Gemini failover HTTP block not found");
  const httpBlock = [
    "if (!r.ok) {",
    ' const bodyText = await r.text().catch(() => "");',
    " let errorBody = {}; try { errorBody = bodyText ? JSON.parse(bodyText) : {}; } catch {}",
    ' const errorCode = errorBody?.error?.status || errorBody?.error?.code || "HTTP_" + r.status;',
    ' const errorMessage3 = errorBody?.error?.message || bodyText || "No error details returned."; ',
    ' lastFailure = "Gemini HTTP " + r.status + " " + String(errorCode) + ": " + String(errorMessage3).slice(0,150);',
    " if (r.status === 429) {",
    "  quotaFailures++; let retryMs = 60000;",
    '  const retryHeader = r.headers.get("retry-after"), retryNumber = Number(retryHeader), retryDate = Date.parse(retryHeader || "");',
    "  if (Number.isFinite(retryNumber) && retryNumber >= 0) retryMs = Math.max(retryMs,retryNumber*1000); else if (Number.isFinite(retryDate)) retryMs = Math.max(retryMs,retryDate-Date.now());",
    '  for (const detail of (Array.isArray(errorBody?.error?.details) ? errorBody.error.details : [])) { const value=detail?.retryDelay||detail?.retry_delay; if(typeof value==="string"&&value.endsWith("s"))retryMs=Math.max(retryMs,Number(value.slice(0,-1))*1000); }',
    "  maxRetryAt=Math.max(maxRetryAt,Date.now()+retryMs);",
    " }",
    ' await env.CIEL_STATE.put("ciel:gemini:key-cursor",String((ix+1)%keys.length),{expirationTtl:86400});',
    " continue;",
    "}",
    ""
  ].join("\n");
  source = source.slice(0, start) + httpBlock + source.slice(end);
  const outIndex = source.indexOf("const out = { verdict, paperMarginMon:");
  const catchStart = source.indexOf("} catch (e) {", outIndex);
  const loopEnd = source.indexOf('\n  }\n  await env.CIEL_STATE.put("ciel:gemini:key-cursor", String((cursor + 1)', catchStart);
  if (outIndex < 0 || catchStart < 0 || loopEnd < 0) throw new Error("Gemini failover catch block not found");
  const catchBlock = [
    "} catch(e){",
    " lastFailure=String(e).slice(0,180);",
    ' await env.CIEL_STATE.put("ciel:gemini:key-cursor",String((ix+1)%keys.length),{expirationTtl:86400});',
    " continue;",
    "}"
  ].join("\n");
  source = source.slice(0, catchStart) + catchBlock + source.slice(loopEnd);
  replaceOnce("const out = { verdict, paperMarginMon:",
    "const out = { verdict, keyIndexUsed: ix + 1, configuredKeyCount: keys.length, paperMarginMon:",
    "expose successful key index");
  const oldTail = 'await env.CIEL_STATE.put("ciel:gemini:key-cursor", String((cursor + 1) % keys.length), { expirationTtl: 86400 });\n  return wait("No Gemini key completed review after invalid-credential rotation.", "GEMINI_KEYS_FAILED");';
  const newTail = [
    "const allQuotaLimited=quotaFailures===keys.length;",
    "const untilMs=allQuotaLimited?Math.max(Date.now()+60000,maxRetryAt):Date.now()+60000;",
    'await env.CIEL_STATE.put(cooldownKey,JSON.stringify({allKeysFailed:true,failures:keys.length,httpStatus:allQuotaLimited?429:503,errorCode:allQuotaLimited?"ALL_KEYS_RATE_LIMITED":"ALL_KEYS_FAILED",message:String(lastFailure).slice(0,170),lastFailureAt:Date.now(),untilMs}),{expirationTtl:604800});',
    'await env.CIEL_STATE.put("ciel:gemini:key-cursor",String((cursor+1)%keys.length),{expirationTtl:86400});',
    'return {...wait("All "+keys.length+" configured Gemini keys failed. Last error: "+String(lastFailure).slice(0,150)+". Retry after "+Math.ceil((untilMs-Date.now())/60000)+" minute(s).",allQuotaLimited?"GEMINI_RATE_LIMIT":"GEMINI_KEYS_FAILED"),flags:[allQuotaLimited?"GEMINI_RATE_LIMIT":"GEMINI_KEYS_FAILED","GEMINI_COOLDOWN"],httpStatus:allQuotaLimited?429:503,retryAt:untilMs,retryInSeconds:Math.ceil((untilMs-Date.now())/1000)};'
  ].join("\n");
  replaceOnce(oldTail, newTail, "apply cooldown only after all keys fail");
}
patchGeminiMultiProjectFailover();

await writeFile(file,source);
console.log("Adaptive market patch complete: BTC/ETH/SOL retain primary priority; BTC/ETH/SOL/BNB/HYPE receive trend-pullback and 5m breakout-retest coverage; other configured markets remain eligible; bounded learning affects ranking only.");
