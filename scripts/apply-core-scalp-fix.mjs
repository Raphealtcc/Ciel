import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const file = path.join(root, "reconstructed", "patched-worker.js");
let source = await readFile(file, "utf8");

function once(before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(label + ": expected one match, found " + count);
  source = source.replace(before, after);
  console.log("Applied core scalp patch: " + label);
}

once(
  'JSON.stringify(intraday),\\n    "24h daily and current/previous hourly high-low levels from stored 5m candles: " + JSON.stringify(candleStructure),',
  'JSON.stringify(intraday),\n    "24h daily and current/previous hourly high-low levels from stored 5m candles: " + JSON.stringify(candleStructure),',
  "normalize literal reviewer-context separator",
);

once(
  'var CANDLE_HISTORY_SYMBOLS = /* @__PURE__ */ new Set(["BTC", "ETH", "MON"]);',
  'var CANDLE_HISTORY_SYMBOLS = /* @__PURE__ */ new Set(["BTC", "ETH", "MON", "SOL"]);',
  "add SOL five-minute candle history while preserving MON",
);

// The minute stream is fetched by REST once per normal sample cycle. Only closed
// candles are persisted; partial candles are never used as entry evidence.
once(
  '  async writeHistory(rows, alerts, now) {',
  `  lastCoreScalpCandleAt = 0;
  async writeCoreScalpCandles(now) {
    if (now - this.lastCoreScalpCandleAt < 55e3) return;
    const isInitialRefresh = this.lastCoreScalpCandleAt === 0;
    this.lastCoreScalpCandleAt = now;
    const symbols = ["BTC", "ETH", "SOL"].filter((symbol) => Number(this.latest[symbol]) > 0);
    const statements = [];
    for (let offset = 0; offset < symbols.length; offset += 3) {
      await Promise.all(symbols.slice(offset, offset + 3).map(async (symbol) => {
        try {
          const response = await fetch(HYPERLIQUID_INFO, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "candleSnapshot", req: { coin: symbol, interval: "1m", startTime: now - 45 * 60e3, endTime: now } }),
            signal: AbortSignal.timeout(8e3)
          });
          if (!response.ok) throw new Error("candleSnapshot HTTP " + response.status);
          const payload = await response.json();
          const candles = (Array.isArray(payload) ? payload : [payload]).filter((c) => {
            if (!c || typeof c !== "object" || Array.isArray(c)) return false;
            const closeAt = Number(c.T || c.t);
            return String(c.s || symbol).toUpperCase() === symbol && String(c.i || "1m") === "1m" &&
              Number(c.t) > 0 && closeAt <= now && [c.o,c.h,c.l,c.c].every((v) => Number.isFinite(Number(v)) && Number(v) > 0);
          }).sort((a,b) => Number(a.t)-Number(b.t));
          const latestClosed = candles[candles.length - 1];
          for (const candle of isInitialRefresh ? candles.slice(-45) : candles.slice(-1)) {
            const latest = candle === latestClosed;
            const sql = latest
              ? "INSERT OR REPLACE INTO market_candles (symbol,interval,open_ts_ms,close_ts_ms,open_price,high_price,low_price,close_price,volume,trade_count,updated_at_ms) VALUES (?,'1m',?,?,?,?,?,?,?,?,?)"
              : "INSERT OR IGNORE INTO market_candles (symbol,interval,open_ts_ms,close_ts_ms,open_price,high_price,low_price,close_price,volume,trade_count,updated_at_ms) VALUES (?,'1m',?,?,?,?,?,?,?,?,?)";
            statements.push(this.env.DB.prepare(sql).bind(
              symbol, Number(candle.t), Number(candle.T || candle.t), Number(candle.o),
              Number(candle.h), Number(candle.l), Number(candle.c),
              Number(candle.v) || 0, Number(candle.n) || 0, now
            ));
          }
        } catch (error) {
          console.error("Core scalp 1m candle refresh failed for " + symbol + ": " + String(error).slice(0,160));
        }
      }));
    }
    if (statements.length) {
      try { await this.env.DB.batch(statements); }
      catch (error) { console.error("Core scalp candle batch failed: " + String(error).slice(0,180)); }
    }
  }
  async writeHistory(rows, alerts, now) {`,
  "add bounded 1-minute BTC/ETH/SOL candle snapshots",
);

once(
  '    const background = [];',
  '    const background = [];\n    if (now - this.lastCoreScalpCandleAt >= 55e3) background.push(this.writeCoreScalpCandles(now));',
  "refresh 1m core candles only after the background task queue is initialized",
);

const analyzer = `function analyzeCorePullbackScalp(symbol, oneMinuteRows, fiveMinuteRows, now) {
  const normalize = (rows, intervalMs) => (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      t: Number(row.close_ts_ms || row.open_ts_ms + intervalMs),
      o: Number(row.open_price), h: Number(row.high_price),
      l: Number(row.low_price), c: Number(row.close_price),
      v: Number(row.volume) || 0
    }))
    .filter((c) => c.t > 0 && [c.o,c.h,c.l,c.c].every((v) => Number.isFinite(v) && v > 0))
    .sort((a,b) => a.t-b.t);
  const m1 = normalize(oneMinuteRows, 60e3), m5 = normalize(fiveMinuteRows, 300e3);
  if (m1.length < 25 || m5.length < 30) return null;
  const last1 = m1[m1.length-1], last5 = m5[m5.length-1];
  if (now-last1.t > 125e3 || now-last5.t > 7*60e3 || last1.t > now+15e3 || last5.t > now+15e3) return null;
  const ema = (values, period) => {
    if (values.length < period) return NaN;
    const k=2/(period+1); let value=values[0];
    for (let i=1;i<values.length;i++) value=values[i]*k+value*(1-k);
    return value;
  };
  const closes5=m5.map(c=>c.c), closes1=m1.map(c=>c.c);
  const fast5=ema(closes5.slice(-30),9), slow5=ema(closes5.slice(-30),21);
  const priorFast5=ema(closes5.slice(-31,-1),9);
  const fast1=ema(closes1.slice(-25),9);
  if (![fast5,slow5,priorFast5,fast1].every(Number.isFinite)) return null;
  const trendUp=fast5>slow5 && fast5>priorFast5 && last5.c>fast5;
  const trendDown=fast5<slow5 && fast5<priorFast5 && last5.c<fast5;
  // Counter-trend reversal scalp, independent of the 5m EMA direction.
  const reversalLatest=m1[m1.length-1],reversalPrevious=m1[m1.length-2];
  const reversalWindow=m1.slice(-18,-3), reversalContext=m1.slice(-25,-3);
  if(reversalWindow.length>=12&&reversalContext.length>=15){
    const swingLow=Math.min(...reversalWindow.map(c=>c.l)),swingHigh=Math.max(...reversalWindow.map(c=>c.h));
    const priorHigh=Math.max(...reversalContext.map(c=>c.h)),priorLow=Math.min(...reversalContext.map(c=>c.l));
    const reversalAtrRows=m1.slice(-15),reversalAtr=reversalAtrRows.reduce((sum,c)=>sum+c.h-c.l,0)/reversalAtrRows.length;
    const reversalAvgVol=m1.slice(-21,-1).reduce((sum,c)=>sum+c.v,0)/20;
    const reversalRsi=(values)=>{
      if(values.length<15)return 50;
      let gains=0,losses=0;
      for(let i=values.length-14;i<values.length;i++){const delta=values[i]-values[i-1];if(delta>0)gains+=delta;else losses-=delta;}
      return losses===0?100:100-100/(1+gains/losses);
    };
    const currentRsi=reversalRsi(closes1.slice(-15)),priorRsi=reversalRsi(closes1.slice(-16,-1));
    const volumeOk=reversalAvgVol<=0||reversalLatest.v>=reversalAvgVol*0.65,recentTouches=m1.slice(-3,-1);
    const longTouch=recentTouches.some(c=>c.l<=swingLow+reversalAtr*0.45),shortTouch=recentTouches.some(c=>c.h>=swingHigh-reversalAtr*0.45);
    const declinePct=priorHigh>0?(priorHigh-swingLow)/priorHigh*100:0,rallyPct=priorLow>0?(swingHigh-priorLow)/priorLow*100:0;
    let side=null,pivot=0;
    if(reversalAtr>0&&declinePct>=0.18&&longTouch&&reversalLatest.c>reversalLatest.o&&reversalLatest.c>reversalPrevious.h&&reversalLatest.c>swingLow+reversalAtr*0.5&&currentRsi>priorRsi&&currentRsi<=58&&volumeOk){side="LONG";pivot=Math.min(swingLow,...m1.slice(-3).map(c=>c.l));}
    else if(reversalAtr>0&&rallyPct>=0.18&&shortTouch&&reversalLatest.c<reversalLatest.o&&reversalLatest.c<reversalPrevious.l&&reversalLatest.c<swingHigh-reversalAtr*0.5&&currentRsi<priorRsi&&currentRsi>=42&&volumeOk){side="SHORT";pivot=Math.max(swingHigh,...m1.slice(-3).map(c=>c.h));}
    if(side){
      const entry=reversalLatest.c,rawStop=side==="LONG"?(entry-pivot)/entry*100:(pivot-entry)/entry*100,stopPct=Math.max(0.12,rawStop+0.04);
      if(stopPct>0&&stopPct<=0.45){
        return {symbol,side,entry,stopPct,targetPct:Math.max(0.25,stopPct*1.5),confidence:Math.min(0.88,0.79+(reversalAvgVol>0&&reversalLatest.v>=reversalAvgVol?0.03:0)),
          scoreComponents:["1M_SWING_EXHAUSTION","1M_PIVOT_RECLAIM","1M_RSI_TURN","1M_VOLUME_CONFIRMATION"],scoreModel:"core-1m-swing-reversal-v1",
          strategy:"1M_SWING_REVERSAL+RECLAIM",regime:"COUNTER_TREND_REVERSAL",mode:"CORE_PULLBACK_SCALP",holdMinutes:12,
          rsi:currentRsi,bounce:null,cci:null,stochRsi:null,rangePositionPct:null,
          reason:"Closed 1m candles confirm swing exhaustion, pivot retest, directional reclaim/rejection, improving RSI and volume. Evaluated independently of 5m EMA direction."};
      }
    }
  }
  if (!trendUp && !trendDown) return null;
  const recent=m1.slice(-5,-1), latest=m1[m1.length-1], previous=m1[m1.length-2];
  const ranges=m1.slice(-15).map(c=>c.h-c.l).filter(v=>v>0);
  const atr=ranges.reduce((a,b)=>a+b,0)/Math.max(1,ranges.length);
  if (!(atr>0)) return null;
  const averageVolume=m1.slice(-21,-1).reduce((sum,c)=>sum+c.v,0)/20;
  const volumeOk=averageVolume<=0 || latest.v>=averageVolume*0.85;
  if (!volumeOk) return null;
  let side=null, pivot=0;
  if (trendUp) {
    const touched=recent.some(c=>c.c<c.o && c.l<=fast1+atr*0.18 && c.l>=fast1-atr*0.75);
    if (touched && latest.c>latest.o && latest.c>previous.h && latest.c>fast1) {
      side="LONG"; pivot=Math.min(...recent.map(c=>c.l),latest.l);
    }
  } else {
    const touched=recent.some(c=>c.c>c.o && c.h>=fast1-atr*0.18 && c.h<=fast1+atr*0.75);
    if (touched && latest.c<latest.o && latest.c<previous.l && latest.c<fast1) {
      side="SHORT"; pivot=Math.max(...recent.map(c=>c.h),latest.h);
    }
  }
  if (!side) return null;
  const entry=latest.c, direction=side==="LONG"?1:-1;
  const rawStop=side==="LONG"?(entry-pivot)/entry*100:(pivot-entry)/entry*100;
  const stopPct=Math.max(0.12,rawStop+0.04);
  // The 100x tier's 11 MON minimum must fit the existing 5 MON per-trade
  // paper risk cap. A wider stop is therefore rejected, not resized upward.
  if (!(stopPct>0 && stopPct<=0.45)) return null;
  const targetPct=Math.max(0.25,stopPct*1.6);
  const body=Math.abs(latest.c-latest.o)/entry*100;
  const confidence=Math.min(0.88,0.76+Math.min(0.07,body*0.12)+(volumeOk?0.02:0));
  return {
    symbol,side,entry,stopPct,targetPct,confidence,
    scoreComponents:["5M_TREND_FILTER","1M_PULLBACK","1M_RECLAIM","VOLUME_CONFIRMATION"],
    scoreModel:"core-pullback-scalp-v1",
    strategy:"5M_TREND+1M_PULLBACK+RECLAIM",
    regime:trendUp?"TREND_UP":"TREND_DOWN",
    mode:"CORE_PULLBACK_SCALP",holdMinutes:15,
    rsi:null,bounce:null,cci:null,stochRsi:null,rangePositionPct:null,
    reason:"Closed 5m candles establish directional EMA9/EMA21 trend; closed 1m candles show a pullback toward EMA9 followed by a directional reclaim and volume confirmation. Entry is the latest closed 1m candle close."
  };
}
__name(analyzeCorePullbackScalp, "analyzeCorePullbackScalp");

`;
once(
  'async function runAdvisorCycle(env, prices, now, lastTickAt, priceHistory, liveEvidence, paperStorage) {',
  analyzer + 'async function runAdvisorCycle(env, prices, now, lastTickAt, priceHistory, liveEvidence, paperStorage) {',
  "add independent closed-candle trend-pullback scalp detector",
);

// Fetch only six bounded candle windows per five-minute advisor cycle.
once(
  '  const eventIntel = await runMarketEventIntelligence(env, hist, symbols, now);',
  `  const eventIntel = await runMarketEventIntelligence(env, hist, symbols, now);
  const coreScalpData = new Map();
  const coreScalpSymbols = ["BTC","ETH","SOL"].filter((symbol) => symbols.includes(symbol));
  const coreCandleResults = await Promise.all(coreScalpSymbols.map(async (symbol) => {
    const [one, five] = await Promise.all([
      env.DB.prepare("SELECT open_ts_ms,close_ts_ms,open_price,high_price,low_price,close_price,volume FROM market_candles WHERE symbol=? AND interval='1m' AND close_ts_ms<=? ORDER BY open_ts_ms DESC LIMIT 60").bind(symbol,now).all(),
      env.DB.prepare("SELECT open_ts_ms,close_ts_ms,open_price,high_price,low_price,close_price,volume FROM market_candles WHERE symbol=? AND interval='5m' AND close_ts_ms<=? ORDER BY open_ts_ms DESC LIMIT 60").bind(symbol,now).all()
    ]);
    return [symbol,(one.results||[]).reverse(),(five.results||[]).reverse()];
  }));
  for (const [symbol,one,five] of coreCandleResults) coreScalpData.set(symbol,{one,five});`,
  "load only recent 1m/5m candles for BTC ETH SOL",
);

once(
  `    const signal = analyzeCandleLevelReversal(sym,marketRows,candleStructureRows.get(sym),now) || analyse(sym,marketRows,now);
    if (signal && signal.confidence >= setting(env.ADVISORY_MIN_CONFIDENCE, 0.72, 0.5, 0.95)) candidates.push(signal);`,
  `    const signal = analyzeCandleLevelReversal(sym,marketRows,candleStructureRows.get(sym),now) || analyse(sym,marketRows,now);
    const isCore = ["BTC","ETH","SOL"].includes(sym);
    if (signal && signal.confidence >= setting(env.ADVISORY_MIN_CONFIDENCE, 0.72, 0.5, 0.95) && (!isCore || signal.mode === "TREND_HOLD")) candidates.push(signal);
    if (isCore) {
      const candles = coreScalpData.get(sym);
      if (candles) {
        const scalp = analyzeCorePullbackScalp(sym,candles.one,candles.five,now);
        if (scalp && scalp.confidence >= setting(env.ADVISORY_MIN_CONFIDENCE,0.72,0.5,0.95)) candidates.push(scalp);
      }
    }`,
  "add core scalp candidates alongside retained trend holds",
);

once(
  `  for (const candidate of candidates) {
    if (candidate.mode === "RANGE_SCALP" && eventIntel?.marketImpact === "BROAD_RISK_OFF") continue;
    const cooldownMs = candidate.mode === "RANGE_SCALP" ? 10 * 6e4 : trendCooldownMs;`,
  `  for (const candidate of candidates) {
    const isScalpMode = candidate.mode === "RANGE_SCALP" || candidate.mode === "CORE_PULLBACK_SCALP";
    if (isScalpMode && eventIntel?.marketImpact === "BROAD_RISK_OFF") continue;
    const cooldownMs = candidate.mode === "CORE_PULLBACK_SCALP" ? 3 * 6e4 : trendCooldownMs;`,
  "evaluate scalp and trend candidates independently and cap Gemini reviews at one per symbol per 30 minutes; core pullback scalps use deterministic local review",
);


once(
  "    const priorReview = await env.DB.prepare(\"SELECT created_at_ms FROM advisor_ai_audit WHERE symbol=? AND model!='CIEL Statistical Ensemble v1' AND model!='CIEL deterministic range guard' ORDER BY created_at_ms DESC LIMIT 1\").bind(candidate.symbol).first();",
  `    const priorReviewSql = candidate.mode === "CORE_PULLBACK_SCALP"
      ? "SELECT created_at_ms FROM advisor_ai_audit WHERE symbol=? AND model='CIEL deterministic core scalp guard' ORDER BY created_at_ms DESC LIMIT 1"
      : candidate.mode === "RANGE_SCALP"
        ? "SELECT created_at_ms FROM advisor_ai_audit WHERE symbol=? AND model='CIEL deterministic range guard' ORDER BY created_at_ms DESC LIMIT 1"
        : "SELECT created_at_ms FROM advisor_ai_audit WHERE symbol=? AND model NOT IN ('CIEL Statistical Ensemble v1','CIEL Statistical Ensemble v1 + technical gate','CIEL deterministic range guard','CIEL deterministic core scalp guard','CIEL deterministic positioning gate','Hyperliquid market-quality gate') ORDER BY created_at_ms DESC LIMIT 1";
    const priorReview = await env.DB.prepare(priorReviewSql).bind(candidate.symbol).first();`,
  "separate scalp and trend review cooldowns and ignore transient pre-review WAIT rows",
);

once(
  '    if (forecastChecks >= 6) break;\n    forecastChecks++;',
  '    if (forecastChecks >= 6 && !isScalpMode) continue;\n    if (!isScalpMode) forecastChecks++;',
  "keep trend review budget from starving deterministic scalp candidates",
);

once(
  `      console.log("Ciel blocked " + candidate.symbol + ": Gemini " + reviewed.verdict + " \\u2014 " + reviewed.reason);
      return;
    }`,
  `      console.log("Ciel blocked " + candidate.symbol + ": review " + reviewed.verdict + " \\u2014 " + reviewed.reason);
      continue;
    }`,
  "continue to the next candidate when one candidate is rejected or waits",
);

once(
  'const intraday = await getIntradayPattern(env,candidate.symbol,now,candidate.entry);\\n    const candleStructure = await getCandleStructureEvidence(env,candidate.symbol,now,candidate.entry);',
  'const intraday = await getIntradayPattern(env,candidate.symbol,now,candidate.entry);\n    const candleStructure = await getCandleStructureEvidence(env,candidate.symbol,now,candidate.entry);',
  "normalize recovered intraday/candle-structure separator",
);

once(
  'const intraday = await getIntradayPattern',
  'const intraday = isScalpMode ? null : await getIntradayPattern',
  "skip intraday research lookups for both scalp modes",
);

once(
  'const reviewed = await review(env,candidate,forecast,reviewerMarket,intraday,eventIntel,candleStructure,sizingLimits);',
  `const reviewed = candidate.mode === "CORE_PULLBACK_SCALP"
      ? { verdict:"WAIT", reason:"Closed 1m/5m pullback, reclaim, volume, freshness and market-quality gates passed; deterministic scalp review avoids extra Gemini calls.", flags:["LOCAL_CORE_PULLBACK_SCALP"], model:"CIEL deterministic core scalp guard", queries:[], sources:[] }
      : await review(env,candidate,forecast,reviewerMarket,intraday,eventIntel,candleStructure,sizingLimits);`,
  "use deterministic local review for core scalps without Gemini calls",
);

once(
  'const waitFallback = reviewed.verdict === "WAIT" && !explicitRisk && (!hasForecast || reviewed.flags.some((flag) => ["NO_GEMINI_KEY", "GEMINI_RATE_LIMIT", "GEMINI_COOLDOWN", "GEMINI_API_ERROR", "GEMINI_UNAVAILABLE", "GEMINI_KEYS_FAILED", "GEMINI_PERMISSION_DENIED", "LOCAL_RANGE_SCALP_REVIEW"].includes(flag)));',
  'const waitFallback = reviewed.verdict === "WAIT" && !explicitRisk && (!hasForecast || reviewed.flags.some((flag) => ["NO_GEMINI_KEY", "GEMINI_RATE_LIMIT", "GEMINI_COOLDOWN", "GEMINI_API_ERROR", "GEMINI_UNAVAILABLE", "GEMINI_KEYS_FAILED", "GEMINI_PERMISSION_DENIED", "LOCAL_RANGE_SCALP_REVIEW", "LOCAL_CORE_PULLBACK_SCALP"].includes(flag)));',
  "allow deterministic scalp review only through existing forecast and market-quality gates",
);

once(
  'const technicalOnly = !hasForecast || reviewed.verdict === "WAIT" && reviewed.model !== "CIEL deterministic range guard";',
  'const technicalOnly = !hasForecast || reviewed.verdict === "WAIT" && !["CIEL deterministic range guard","CIEL deterministic core scalp guard"].includes(reviewed.model);',
  "label core scalp confirmation correctly",
);

once(
  'holdMinutes:candidate.holdMinutes || (candidate.mode === "RANGE_SCALP" ? 12 : 180), mode:candidate.mode',
  'holdMinutes:candidate.holdMinutes || (candidate.mode === "CORE_PULLBACK_SCALP" ? 15 : candidate.mode === "RANGE_SCALP" ? 12 : 180), mode:candidate.mode',
  "set dedicated 15-minute paper hold for core scalps",
);

once(
  'mode: params.mode === "RANGE_SCALP" ? "RANGE_SCALP" : "TREND_HOLD",',
  'mode: params.mode === "CORE_PULLBACK_SCALP" ? "CORE_PULLBACK_SCALP" : params.mode === "RANGE_SCALP" ? "RANGE_SCALP" : "TREND_HOLD",',
  "persist the new paper strategy mode distinctly",
);

once(
  'const localRangeReview = r.model === "CIEL deterministic range guard";',
  'const localRangeReview = r.model === "CIEL deterministic range guard";\n  const localCoreScalpReview = r.model === "CIEL deterministic core scalp guard";',
  "recognize local core scalp confirmation",
);

once(
  'const researchReady = r.verdict === "APPROVE" || localRangeReview;',
  'const researchReady = r.verdict === "APPROVE" || localRangeReview || localCoreScalpReview;',
  "allow deterministic core scalp guard in confirmation display",
);

once(
  'fullyConfirmed\n      ? (localRangeReview ? "✅ Local range, statistical forecast and market-quality gates support this scalp; Gemini was intentionally skipped." : "✅ Forecast envelope and Gemini review support this direction.")',
  'fullyConfirmed\n      ? (localCoreScalpReview ? "✅ Closed-candle pullback/reclaim, statistical forecast and market-quality gates support this scalp; Gemini was intentionally skipped." : localRangeReview ? "✅ Local range, statistical forecast and market-quality gates support this scalp; Gemini was intentionally skipped." : "✅ Forecast envelope and Gemini review support this direction.")',
  "show core scalp's actual confirmation evidence",
);

once(
  'const regimeLine = s.mode === "RANGE_SCALP"\n    ? "Market regime: RANGE | 30-minute support/resistance band " + Number(s.rangeWidthPct).toFixed(2) + "% wide; entries only at confirmed outer edges, target is the range midpoint."',
  'const regimeLine = s.mode === "CORE_PULLBACK_SCALP"\n    ? "Market regime: " + String(s.regime) + " | 5m EMA trend filter + closed 1m pullback/reclaim."\n    : s.mode === "RANGE_SCALP"\n    ? "Market regime: RANGE | 30-minute support/resistance band " + Number(s.rangeWidthPct).toFixed(2) + "% wide; entries only at confirmed outer edges, target is the range midpoint."',
  "describe core pullback market regime in setup card",
);

once(
  '"Execution mode: " + (s.mode === "RANGE_SCALP" ? "RANGE SCALP" : "TREND HOLD") + " | maximum paper hold " + String(s.holdMinutes || (s.mode === "RANGE_SCALP" ? 12 : 180)) + "m",',
  '"Execution mode: " + (s.mode === "CORE_PULLBACK_SCALP" ? "CORE PULLBACK SCALP" : s.mode === "RANGE_SCALP" ? "RANGE SCALP" : "TREND HOLD") + " | maximum paper hold " + String(s.holdMinutes || (s.mode === "CORE_PULLBACK_SCALP" ? 15 : s.mode === "RANGE_SCALP" ? 12 : 180)) + "m",',
  "label new scalp mode in Telegram setup card",
);

once(
  'const reviewSummary = reviewed.model === "CIEL deterministic range guard" ? "Local deterministic range review: " + reviewed.reason : "Gemini " + reviewed.verdict + ": " + reviewed.reason;',
  'const reviewSummary = reviewed.model === "CIEL deterministic core scalp guard" || reviewed.model === "CIEL deterministic range guard" ? "Local deterministic review: " + reviewed.reason : "Gemini " + reviewed.verdict + ": " + reviewed.reason;',
  "record deterministic core scalp review in proposal rationale",
);

once(
  'candidate.mode === "RANGE_SCALP" ? 12 : 180',
  'candidate.mode === "CORE_PULLBACK_SCALP" ? 15 : candidate.mode === "RANGE_SCALP" ? 12 : 180',
  "retain correct hold duration in all fallback paths",
);


const legacyModeLabel = 'trade.mode === "RANGE_SCALP" ? "RANGE SCALP" : trade.mode === "TREND_HOLD" ? "TREND HOLD" : "LEGACY"';
const legacyModeCount = source.split(legacyModeLabel).length - 1;
if (legacyModeCount !== 2) throw new Error("Expected two paper summary mode labels, found " + legacyModeCount);
source = source.replaceAll(legacyModeLabel, 'trade.mode === "CORE_PULLBACK_SCALP" ? "CORE PULLBACK SCALP" : trade.mode === "RANGE_SCALP" ? "RANGE SCALP" : trade.mode === "TREND_HOLD" ? "TREND HOLD" : "LEGACY"');
console.log("Applied core scalp patch: show core pullback trades distinctly in paper summaries");

once(
  '    this.xyzQntMid = values[22] || null;\n    this.lastXyzQntRefreshAt = Number(values[23]) || 0;\n    this.historyBootstrapDone = values[24] === true;\n    this.lastHistoryBootstrapAt = Number(values[25]) || 0;',
  '    this.xyzQntMid = values[24] || null;\n    this.lastXyzQntRefreshAt = Number(values[25]) || 0;\n    this.historyBootstrapDone = values[26] === true;\n    this.lastHistoryBootstrapAt = Number(values[27]) || 0;',
  "align restored QNT and history bootstrap state with the expanded Durable Object restore list",
);

await writeFile(file, source);
console.log("Wrote core BTC/ETH/SOL pullback scalp candidate to reconstructed/patched-worker.js");
