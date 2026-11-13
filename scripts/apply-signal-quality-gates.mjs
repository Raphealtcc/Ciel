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

patchFunction("analyzeTrendPullbackEntry", "__name(analyzeTrendPullbackEntry", (segment) => {
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
let shadowFunction = JSON.parse("\"\\nasync function updateAdvisorShadowOutcomes(env, now) {\\n  const cacheKey = \\\"ciel:advisor:shadow-stats:v2\\\";\\n  const lastKey = \\\"ciel:advisor:shadow-outcomes:v2:last-run\\\";\\n  const cached = await env.CIEL_STATE.get(cacheKey, \\\"json\\\").catch(() => ({})) || {};\\n  const lastRun = Number(await env.CIEL_STATE.get(lastKey).catch(() => 0));\\n  if (now - lastRun < 30 * 60e3) return cached;\\n  await env.CIEL_STATE.put(lastKey, String(now), { expirationTtl: 86400 }).catch(() => void 0);\\n  const updateSql = `WITH eligible AS (\\n    SELECT id,symbol,side,entry_price,stop_price,target_price,stop_pct,target_pct,strategy,created_at_ms,\\n      CASE\\n        WHEN strategy LIKE '%MICRO_MOMENTUM%' THEN 45*60000\\n        WHEN strategy LIKE '%CONTINUATION%' THEN 180*60000\\n        WHEN strategy LIKE '%SWING_REVERSAL%' THEN 180*60000\\n        WHEN strategy LIKE '%RANGE_REVERSION%' THEN 12*60000\\n        WHEN strategy LIKE '%LEVEL_SWEEP%' THEN 180*60000\\n        WHEN strategy LIKE '%PULLBACK%' THEN CASE WHEN strategy LIKE '%5M_TREND%PULLBACK%' THEN 180*60000 ELSE 15*60000 END\\n        ELSE 180*60000\\n      END AS hold_ms\\n    FROM advisor_positions\\n    WHERE status='EXPIRED' AND exit_reason IS NULL\\n      AND tracking_started_at_ms IS NULL AND manual_entry_at_ms IS NULL AND actual_entry_price IS NULL\\n      AND created_at_ms>=?\\n      AND (strategy NOT LIKE '%LEVEL_SWEEP%' OR created_at_ms >= 1794397468000)\\n      AND created_at_ms + CASE\\n        WHEN strategy LIKE '%MICRO_MOMENTUM%' THEN 45*60000\\n        WHEN strategy LIKE '%CONTINUATION%' THEN 180*60000\\n        WHEN strategy LIKE '%SWING_REVERSAL%' THEN 180*60000\\n        WHEN strategy LIKE '%RANGE_REVERSION%' THEN 12*60000\\n        WHEN strategy LIKE '%LEVEL_SWEEP%' THEN 180*60000\\n        WHEN strategy LIKE '%PULLBACK%' THEN CASE WHEN strategy LIKE '%5M_TREND%PULLBACK%' THEN 180*60000 ELSE 15*60000 END\\n        ELSE 180*60000\\n      END <= ?\\n    ORDER BY created_at_ms ASC\\n    LIMIT 40\\n  ), scored AS (\\n    SELECT e.*,\\n      e.created_at_ms+e.hold_ms AS horizon_ms,\\n      (SELECT MIN(m.ts_ms) FROM market_samples m WHERE m.symbol=e.symbol AND m.ts_ms>=e.created_at_ms AND m.ts_ms<=e.created_at_ms+e.hold_ms\\n        AND ((e.side='LONG' AND m.mid_price<=e.stop_price) OR (e.side='SHORT' AND m.mid_price>=e.stop_price))) AS stop_at,\\n      (SELECT MIN(m.ts_ms) FROM market_samples m WHERE m.symbol=e.symbol AND m.ts_ms>=e.created_at_ms AND m.ts_ms<=e.created_at_ms+e.hold_ms\\n        AND ((e.side='LONG' AND m.mid_price>=e.target_price) OR (e.side='SHORT' AND m.mid_price<=e.target_price))) AS target_at,\\n      (SELECT m.mid_price FROM market_samples m WHERE m.symbol=e.symbol AND m.ts_ms>=e.created_at_ms AND m.ts_ms<=e.created_at_ms+e.hold_ms ORDER BY m.ts_ms DESC LIMIT 1) AS final_price,\\n      (SELECT MAX(m.ts_ms) FROM market_samples m WHERE m.symbol=e.symbol AND m.ts_ms>=e.created_at_ms AND m.ts_ms<=e.created_at_ms+e.hold_ms) AS final_ts,\\n      (SELECT COUNT(*) FROM market_samples m WHERE m.symbol=e.symbol AND m.ts_ms>=e.created_at_ms AND m.ts_ms<=e.created_at_ms+e.hold_ms) AS sample_count\\n    FROM eligible e\\n  )\\n  UPDATE advisor_positions\\n  SET exit_reason=(SELECT CASE\\n        WHEN sample_count<2 OR final_price IS NULL OR final_ts IS NULL OR final_ts<horizon_ms-10*60000 THEN 'SHADOW_INSUFFICIENT_DATA'\\n        WHEN target_at IS NOT NULL AND stop_at IS NOT NULL AND target_at=stop_at THEN 'SHADOW_AMBIGUOUS'\\n        WHEN target_at IS NOT NULL AND (stop_at IS NULL OR target_at<stop_at) THEN 'SHADOW_TARGET_FIRST'\\n        WHEN stop_at IS NOT NULL AND (target_at IS NULL OR stop_at<target_at) THEN 'SHADOW_STOP_FIRST'\\n        ELSE 'SHADOW_TIME_EXIT' END\\n      FROM scored WHERE scored.id=advisor_positions.id),\\n      exit_price=(SELECT final_price FROM scored WHERE scored.id=advisor_positions.id),\\n      closed_at_ms=(SELECT final_ts FROM scored WHERE scored.id=advisor_positions.id),\\n      updated_at_ms=?\\n  WHERE id IN (SELECT id FROM scored)`;\\n  try {\\n    await env.DB.prepare(updateSql).bind(now-30*86400e3, now, now).run();\\n    const statsLastRefreshKey = 'ciel:advisor:shadow-stats:v2:last-refresh';\\n    const statsLastRefresh = Number(await env.CIEL_STATE.get(statsLastRefreshKey).catch(() => 0));\\n    if (now - statsLastRefresh < 6 * 60 * 60e3) return cached;\\n    const stats = await env.DB.prepare(`SELECT strategy,CASE\\n      WHEN strategy LIKE '%MICRO_MOMENTUM%' THEN 45\\n      WHEN strategy LIKE '%CONTINUATION%' THEN 180\\n      WHEN strategy LIKE '%SWING_REVERSAL%' THEN 180\\n      WHEN strategy LIKE '%RANGE_REVERSION%' THEN 12\\n      WHEN strategy LIKE '%LEVEL_SWEEP%' THEN 180\\n      WHEN strategy LIKE '%5M_TREND%PULLBACK%' THEN 180\\n      WHEN strategy LIKE '%PULLBACK%' THEN 15\\n      ELSE 180 END AS horizon_minutes,COUNT(*) AS sample_count,\\n      AVG(CASE\\n        WHEN exit_reason='SHADOW_TARGET_FIRST' THEN (target_pct-0.06)/NULLIF(stop_pct,0)\\n        WHEN exit_reason='SHADOW_STOP_FIRST' THEN -1-0.06/NULLIF(stop_pct,0)\\n        WHEN exit_reason='SHADOW_TIME_EXIT' THEN ((CASE WHEN side='LONG' THEN 1 ELSE -1 END)*(exit_price/entry_price-1)*100-0.06)/NULLIF(stop_pct,0)\\n      END) AS expectancy_r,\\n      AVG(CASE\\n        WHEN exit_reason='SHADOW_TARGET_FIRST' THEN CASE WHEN target_pct>0.06 THEN 1 ELSE 0 END\\n        WHEN exit_reason='SHADOW_STOP_FIRST' THEN 0\\n        WHEN exit_reason='SHADOW_TIME_EXIT' THEN CASE WHEN (CASE WHEN side='LONG' THEN 1 ELSE -1 END)*(exit_price/entry_price-1)>0.0006 THEN 1 ELSE 0 END\\n      END) AS win_rate\\n      FROM advisor_positions\\n      WHERE status='EXPIRED' AND exit_reason IN ('SHADOW_TARGET_FIRST','SHADOW_STOP_FIRST','SHADOW_TIME_EXIT')\\n        AND created_at_ms>=?\\n      AND (strategy NOT LIKE '%LEVEL_SWEEP%' OR created_at_ms >= 1794397468000)\\n      GROUP BY strategy,horizon_minutes`).bind(now-30*86400e3-3*60*60e3).all();\\n    const profile = {};\\n    for (const row of stats.results || []) profile[row.strategy] = {\\n      horizonMinutes: Number(row.horizon_minutes || 0),\\n      sampleCount: Number(row.sample_count || 0),\\n      expectancyR: Number(row.expectancy_r || 0),\\n      winRate: Number(row.win_rate || 0),\\n      basis: \\\"coarse mid-price shadow outcomes; net of modeled 3 bps-per-side fees, gross of spread, funding and slippage\\\",\\n    };\\n    await env.CIEL_STATE.put(cacheKey, JSON.stringify(profile), { expirationTtl: 2*86400 });\\n    await env.CIEL_STATE.put(statsLastRefreshKey, String(now), { expirationTtl: 7*86400 }).catch(() => void 0);\\n    return profile;\\n  } catch (error) {\\n    console.error(\\\"CIEL shadow outcome update failed: \\\" + String(error?.message || error).slice(0, 240));\\n    return cached;\\n  }\\n}\\n\"")
const horizonMigrationAnchor = "  if (now - lastRun < 30 * 60e3) return cached;";
const horizonMigrationCode = `  let horizonMigrationJustRan = false;
  const horizonMigrationKey = "ciel:advisor:shadow-horizon-migration:v1";
  const horizonMigrationDone = await env.CIEL_STATE.get(horizonMigrationKey).catch(() => null);
  if (!horizonMigrationDone) {
    try {
      const migration = await env.DB.prepare("UPDATE advisor_positions SET exit_reason=NULL,exit_price=NULL,closed_at_ms=NULL,updated_at_ms=? WHERE status='EXPIRED' AND exit_reason LIKE 'SHADOW_%' AND (strategy LIKE '%5M_TREND%PULLBACK%' OR strategy LIKE '%SWING_REVERSAL%' OR strategy LIKE '%CONTINUATION%') AND created_at_ms>=? AND tracking_started_at_ms IS NULL AND manual_entry_at_ms IS NULL AND actual_entry_price IS NULL").bind(now, now-30*86400e3).run();
      await env.CIEL_STATE.put(horizonMigrationKey, String(now), { expirationTtl: 90*86400 });
      horizonMigrationJustRan = true;
      console.info("CIEL_SHADOW_HORIZON_MIGRATION " + JSON.stringify({updated:Number(migration.meta?.changes || 0),holdMinutes:180}));
    } catch (error) {
      console.error("CIEL shadow horizon migration failed: " + String(error?.message || error).slice(0,180));
    }
  }
`;
if (!shadowFunction.includes(horizonMigrationAnchor)) throw new Error("shadow horizon migration insertion anchor missing");
shadowFunction = shadowFunction.replace(horizonMigrationAnchor, horizonMigrationCode + horizonMigrationAnchor);
shadowFunction = shadowFunction.replace(horizonMigrationAnchor, "  if (!horizonMigrationJustRan && now - lastRun < 30 * 60e3) return cached;");
const newline = String.fromCharCode(10);
const runIndex = source.indexOf(runSig);
if (runIndex < 0) throw new Error("runAdvisorCycle declaration not found after shadow helper insertion");
source = source.slice(0, runIndex) + shadowFunction + newline + source.slice(runIndex);
const runIndexAfterHelper = source.indexOf(runSig);
const runBodyInsertAt = runIndexAfterHelper + runSig.length;
source = source.slice(0, runBodyInsertAt) + newline + "  const strategyShadowStats = await updateAdvisorShadowOutcomes(env, now);" + newline + source.slice(runBodyInsertAt);
console.log("Applied signal-quality patch: evaluate unfilled recommendations and learn fee-adjusted shadow expectancy");
const technicalScoreAnchor = '"Technical: " + score + "/100';
const technicalScoreAt = source.indexOf(technicalScoreAnchor);
if (technicalScoreAt < 0 || source.indexOf(technicalScoreAnchor, technicalScoreAt + technicalScoreAnchor.length) >= 0) throw new Error("Could not locate a unique technical score line for quality annotation.");
const technicalScoreLineStart = source.lastIndexOf(newline, technicalScoreAt) + 1;
const technicalScoreLineEnd = source.indexOf(newline, technicalScoreAt);
if (technicalScoreLineEnd < 0 || !source.slice(technicalScoreLineStart, technicalScoreLineEnd).includes("String(s?.strategy")) throw new Error("Technical score line format changed; refusing to patch the wrong Telegram message.");
source = source.slice(0, technicalScoreLineEnd) + newline + '  "Signal quality: " + Number(s?.signalQualityScore || 0) + "/100 evidence score, not win probability",' + source.slice(technicalScoreLineEnd);
console.log("Applied signal-quality patch: show the evidence-quality score on each Telegram recommendation");

const duplicateAnchor = '    const quality = await getMarketEvidence(env, candidate.symbol, now, liveEvidence?.[candidate.symbol]);';
const duplicateReplacement = `    const duplicateSignalKey = "ciel:advisor:duplicate:v1:" + candidate.symbol + ":" + candidate.side + ":" + String(candidate.strategy || candidate.mode || "UNKNOWN");
    const priorSameSignal = await env.CIEL_STATE.get(duplicateSignalKey, "json").catch(() => null);
    const duplicateDecision = shouldSuppressDuplicateSignal({candidate,priorSignal:priorSameSignal,now});
    if (duplicateDecision.suppress) {
      scanDiagnostics.push({symbol:candidate.symbol,strategy:candidate.strategy,reason:"REPEATED_SETUP_SUPPRESSED",ageMinutes:Math.round(duplicateDecision.ageMs/60000),entryDisplacementPct:Number(duplicateDecision.displacementPct.toFixed(3))});
      continue;
    }
    const quality = await getMarketEvidence(env, candidate.symbol, now, liveEvidence?.[candidate.symbol]);`;
once(duplicateAnchor, duplicateReplacement, "suppress repeated setups with KV instead of a D1 query");

once(
  '    if ((inserted.meta?.changes || 0) > 0) {',
  '    if ((inserted.meta?.changes || 0) > 0) {\n      await env.CIEL_STATE.put(duplicateSignalKey, JSON.stringify({created_at_ms: now, entry_price: candidate.entry}), {expirationTtl: 5400}).catch(() => void 0);',
  "persist duplicate-suppression state only after a proposal is inserted"
);

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
