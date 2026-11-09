import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const file = path.join(process.cwd(), "reconstructed", "patched-worker.js");
let source = await readFile(file, "utf8");
const importLine = 'import { evaluateSignalQuality, shouldSuppressDuplicateSignal } from "../src/signal-quality.js";';
if (!source.includes(importLine)) source = importLine + "\n" + source;

function once(before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(label + ": expected exactly one match, found " + count);
  source = source.replace(before, after);
  console.log("Applied signal-quality patch: " + label);
}

function patchFunction(name, endMarker, transform, label) {
  const start = source.indexOf("function " + name + "(");
  if (start < 0) throw new Error(label + ": function not found");
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(label + ": function end marker not found");
  const before = source.slice(start, end);
  const after = transform(before);
  if (before === after) throw new Error(label + ": no change made");
  source = source.slice(0, start) + after + source.slice(end);
  console.log("Applied signal-quality patch: " + label);
}

patchFunction("analyzeMicroMomentumContinuation", "__name(analyzeMicroMomentumContinuation", (segment) => {
  let next = segment.replace(".slice(-40);", ".slice(-200);");
  next = next.replace("function analyzeMicroMomentumContinuation(symbol,rows,now){", 'function analyzeMicroMomentumContinuation(symbol,rows,now){\n  if(!["BTC","ETH","SOL"].includes(symbol))return null;');
  if (next === segment) throw new Error("micro-momentum history window was not found");
  const anchor = "  if(!side)return null;\n  const swing=";
  const replacement = `  if(!side)return null;
  const r15=anchoredReturn(points,15),r60=anchoredReturn(points,60);
  const e20=emaTimed(points.slice(-120),20),e50=emaTimed(points,50);
  const regimeData=classifyMarketRegime(points,r5,r15,anchoredReturn(points,60),e20,e50);
  const trendUp=regimeData.efficiency>=0.24&&regimeData.emaGapPct>=0.035&&e20>e50&&r15>0.06&&r5>0.025&&r60>0.08;
  const trendDown=regimeData.efficiency>=0.24&&regimeData.emaGapPct>=0.035&&e20<e50&&r15< -0.06&&r5< -0.025&&r60< -0.08;
  if((side==="LONG"&&!trendUp)||(side==="SHORT"&&!trendDown))return null;
  const swing=`;
  if (!next.includes(anchor)) throw new Error("micro-momentum trend-regime anchor not found");
  next = next.replace(anchor, replacement);
  return next;
}, "require micro-momentum breakouts to agree with the 15m/30m trend regime");

patchFunction("analyzeCorePullbackScalp", "__name(analyzeCorePullbackScalp", (segment) => {
  const anchor = '    if(side){\n      const entry=reversalLatest.c';
  const replacement = `    const fiveContext=m5.slice(-4,-1);
    const fivePriorHigh=fiveContext.length?Math.max(...fiveContext.map(c=>c.h)):Infinity;
    const fivePriorLow=fiveContext.length?Math.min(...fiveContext.map(c=>c.l)):-Infinity;
    const fiveLongConfirm=last5.c>last5.o&&last5.c>fivePriorHigh&&fast5>priorFast5;
    const fiveShortConfirm=last5.c<last5.o&&last5.c<fivePriorLow&&fast5<priorFast5;
    if(side==="LONG"&&!fiveLongConfirm)side=null;
    if(side==="SHORT"&&!fiveShortConfirm)side=null;
    if(side){
      const entry=reversalLatest.c`;
  if (!segment.includes(anchor)) throw new Error("1m swing-reversal 5m-confirmation anchor not found");
  let next = segment.replace(anchor, replacement);
  const components = '["1M_SWING_EXHAUSTION","1M_PIVOT_RECLAIM","1M_RSI_TURN","1M_VOLUME_CONFIRMATION"]';
  const withFiveMinute = '["1M_SWING_EXHAUSTION","1M_PIVOT_RECLAIM","1M_RSI_TURN","1M_VOLUME_CONFIRMATION","5M_REVERSAL_CONFIRMATION"]';
  if (!next.includes(components)) throw new Error("swing-reversal score component list not found");
  next = next.replace(components, withFiveMinute);
  return next;
}, "require a closed 5m reversal confirmation for 1m swing-reversal entries");

const runSig = "async function runAdvisorCycle(env, prices, now, lastTickAt, priceHistory, liveEvidence, paperStorage, coreScalpCandles = {}, coreTrendCandles = {}) {";
const shadowFunction = "\nasync function updateAdvisorShadowOutcomes(env, now) {\n  const cacheKey = \"ciel:advisor:shadow-stats:v1\";\n  const lastKey = \"ciel:advisor:shadow-outcomes:last-run\";\n  const cached = await env.CIEL_STATE.get(cacheKey, \"json\").catch(() => ({})) || {};\n  const lastRun = Number(await env.CIEL_STATE.get(lastKey).catch(() => 0));\n  if (now - lastRun < 5 * 60e3) return cached;\n  await env.CIEL_STATE.put(lastKey, String(now), { expirationTtl: 86400 }).catch(() => void 0);\n  const updateSql = `WITH eligible AS (\n    SELECT id,symbol,side,entry_price,stop_price,target_price,stop_pct,target_pct,strategy,created_at_ms,\n      CASE\n        WHEN strategy LIKE '%MICRO_MOMENTUM%' THEN 45*60000\n        WHEN strategy LIKE '%CONTINUATION%' THEN 60*60000\n        WHEN strategy LIKE '%SWING_REVERSAL%' OR strategy LIKE '%LEVEL_SWEEP%' OR strategy LIKE '%RANGE_REVERSION%' THEN 12*60000\n        WHEN strategy LIKE '%PULLBACK%' THEN 15*60000\n        ELSE 180*60000\n      END AS hold_ms\n    FROM advisor_positions\n    WHERE status='EXPIRED' AND exit_reason IS NULL\n      AND tracking_started_at_ms IS NULL AND manual_entry_at_ms IS NULL AND actual_entry_price IS NULL\n      AND created_at_ms>=?\n      AND created_at_ms + CASE\n        WHEN strategy LIKE '%MICRO_MOMENTUM%' THEN 45*60000\n        WHEN strategy LIKE '%CONTINUATION%' THEN 60*60000\n        WHEN strategy LIKE '%SWING_REVERSAL%' OR strategy LIKE '%LEVEL_SWEEP%' OR strategy LIKE '%RANGE_REVERSION%' THEN 12*60000\n        WHEN strategy LIKE '%PULLBACK%' THEN 15*60000\n        ELSE 180*60000\n      END <= ?\n    ORDER BY created_at_ms ASC\n    LIMIT 40\n  ), scored AS (\n    SELECT e.*,\n      e.created_at_ms+e.hold_ms AS horizon_ms,\n      (SELECT MIN(m.ts_ms) FROM market_samples m WHERE m.symbol=e.symbol AND m.ts_ms>=e.created_at_ms AND m.ts_ms<=e.created_at_ms+e.hold_ms\n        AND ((e.side='LONG' AND m.mid_price<=e.stop_price) OR (e.side='SHORT' AND m.mid_price>=e.stop_price))) AS stop_at,\n      (SELECT MIN(m.ts_ms) FROM market_samples m WHERE m.symbol=e.symbol AND m.ts_ms>=e.created_at_ms AND m.ts_ms<=e.created_at_ms+e.hold_ms\n        AND ((e.side='LONG' AND m.mid_price>=e.target_price) OR (e.side='SHORT' AND m.mid_price<=e.target_price))) AS target_at,\n      (SELECT m.mid_price FROM market_samples m WHERE m.symbol=e.symbol AND m.ts_ms>=e.created_at_ms AND m.ts_ms<=e.created_at_ms+e.hold_ms ORDER BY m.ts_ms DESC LIMIT 1) AS final_price,\n      (SELECT MAX(m.ts_ms) FROM market_samples m WHERE m.symbol=e.symbol AND m.ts_ms>=e.created_at_ms AND m.ts_ms<=e.created_at_ms+e.hold_ms) AS final_ts,\n      (SELECT COUNT(*) FROM market_samples m WHERE m.symbol=e.symbol AND m.ts_ms>=e.created_at_ms AND m.ts_ms<=e.created_at_ms+e.hold_ms) AS sample_count\n    FROM eligible e\n  )\n  UPDATE advisor_positions\n  SET exit_reason=(SELECT CASE\n        WHEN sample_count<2 OR final_price IS NULL OR final_ts IS NULL OR final_ts<horizon_ms-10*60000 THEN 'SHADOW_INSUFFICIENT_DATA'\n        WHEN target_at IS NOT NULL AND stop_at IS NOT NULL AND target_at=stop_at THEN 'SHADOW_AMBIGUOUS'\n        WHEN target_at IS NOT NULL AND (stop_at IS NULL OR target_at<stop_at) THEN 'SHADOW_TARGET_FIRST'\n        WHEN stop_at IS NOT NULL AND (target_at IS NULL OR stop_at<target_at) THEN 'SHADOW_STOP_FIRST'\n        ELSE 'SHADOW_TIME_EXIT' END\n      FROM scored WHERE scored.id=advisor_positions.id),\n      exit_price=(SELECT final_price FROM scored WHERE scored.id=advisor_positions.id),\n      closed_at_ms=(SELECT final_ts FROM scored WHERE scored.id=advisor_positions.id),\n      updated_at_ms=?\n  WHERE id IN (SELECT id FROM scored)`;\n  try {\n    await env.DB.prepare(updateSql).bind(now-30*86400e3, now, now).run();\n    const stats = await env.DB.prepare(`SELECT strategy,COUNT(*) AS sample_count,\n      AVG(CASE\n        WHEN exit_reason='SHADOW_TARGET_FIRST' THEN target_pct/NULLIF(stop_pct,0)\n        WHEN exit_reason='SHADOW_STOP_FIRST' THEN -1\n        WHEN exit_reason='SHADOW_TIME_EXIT' THEN (CASE WHEN side='LONG' THEN 1 ELSE -1 END)*(exit_price/entry_price-1)*100/NULLIF(stop_pct,0)\n      END) AS expectancy_r,\n      AVG(CASE\n        WHEN exit_reason='SHADOW_TARGET_FIRST' THEN 1\n        WHEN exit_reason='SHADOW_STOP_FIRST' THEN 0\n        WHEN exit_reason='SHADOW_TIME_EXIT' THEN CASE WHEN (CASE WHEN side='LONG' THEN 1 ELSE -1 END)*(exit_price/entry_price-1)>0 THEN 1 ELSE 0 END\n      END) AS win_rate\n      FROM advisor_positions\n      WHERE exit_reason IN ('SHADOW_TARGET_FIRST','SHADOW_STOP_FIRST','SHADOW_TIME_EXIT')\n        AND closed_at_ms>=?\n      GROUP BY strategy`).bind(now-30*86400e3).all();\n    const profile = {};\n    for (const row of stats.results || []) profile[row.strategy] = {\n      sampleCount: Number(row.sample_count || 0),\n      expectancyR: Number(row.expectancy_r || 0),\n      winRate: Number(row.win_rate || 0),\n      basis: \"coarse mid-price shadow outcomes; gross of execution fees\",\n    };\n    await env.CIEL_STATE.put(cacheKey, JSON.stringify(profile), { expirationTtl: 2*86400 });\n    return profile;\n  } catch (error) {\n    console.error(\"CIEL shadow outcome update failed: \" + String(error?.message || error).slice(0, 240));\n    return cached;\n  }\n}\n";
if (!source.includes(runSig)) throw new Error("runAdvisorCycle insertion point missing");
source = source.replace(runSig, shadowFunction + "\\n" + runSig);
const runIndex = source.indexOf(runSig);
if (runIndex < 0) throw new Error("runAdvisorCycle declaration not found after shadow helper insertion");
const runBodyInsertAt = runIndex + runSig.length;
source = source.slice(0, runBodyInsertAt) + "\\n  const strategyShadowStats = await updateAdvisorShadowOutcomes(env, now);\\n" + source.slice(runBodyInsertAt);
console.log("Applied signal-quality patch: evaluate unfilled recommendations and learn gross shadow expectancy");
const duplicateAnchor = '    if (priorReview && now - Number(priorReview.created_at_ms) < cooldownMs) continue;\n    const quality = await getMarketEvidence';
const duplicateReplacement = `    if (priorReview && now - Number(priorReview.created_at_ms) < cooldownMs) continue;
    const priorSameSignal = await env.DB.prepare("SELECT created_at_ms,entry_price FROM advisor_positions WHERE symbol=? AND side=? AND strategy=? AND created_at_ms>=? ORDER BY created_at_ms DESC LIMIT 1").bind(candidate.symbol,candidate.side,candidate.strategy,now-90*6e4).first();
    const duplicateDecision = shouldSuppressDuplicateSignal({candidate,priorSignal:priorSameSignal,now});
    if (duplicateDecision.suppress) {
      scanDiagnostics.push({symbol:candidate.symbol,strategy:candidate.strategy,reason:"REPEATED_SETUP_SUPPRESSED",ageMinutes:Math.round(duplicateDecision.ageMs/60000),entryDisplacementPct:Number(duplicateDecision.displacementPct.toFixed(3))});
      continue;
    }
    const quality = await getMarketEvidence`;
once(duplicateAnchor, duplicateReplacement, "suppress repeated same-side/same-strategy setups until price materially rearms");

const qualityAnchor = "    const intraday = isScalpMode ? null : await getIntradayPattern";
const qualityCode = `    const signalQuality = evaluateSignalQuality({candidate,forecast,market:reviewerMarket,eventIntel,strategyStats:strategyShadowStats});
    if (!signalQuality.allowed) {
      scanDiagnostics.push({symbol:candidate.symbol,strategy:candidate.strategy,reason:"SIGNAL_QUALITY_GATE",score:signalQuality.score,threshold:signalQuality.threshold,flags:signalQuality.vetoes});
      continue;
    }
    candidate.signalQualityScore = signalQuality.score;
    candidate.signalQualityBreakdown = signalQuality.components;
    candidate.reason = String(candidate.reason || "") + " Signal quality " + signalQuality.score + "/100 (evidence score, not a win probability).";
`;
once(qualityAnchor, qualityCode + qualityAnchor, "require a multi-domain signal-quality pass before Gemini review or Telegram notification");

once(
  'technicalScoreComponents: candidate.scoreComponents, rsi:candidate.rsi',
  'technicalScoreComponents: candidate.scoreComponents, signalQualityScore:signalQuality.score, signalQualityComponents:signalQuality.components, rsi:candidate.rsi',
  "persist the evidence score and component breakdown in the existing audit row"
);

await writeFile(file, source);
console.log("Wrote signal-quality-gated Worker candidate: " + file);
