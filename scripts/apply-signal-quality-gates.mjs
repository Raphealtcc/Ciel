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
  if (next === segment) throw new Error("micro-momentum history window was not found");
  const anchor = "  if(!side)return null;\n  const swing=";
  const replacement = `  if(!side)return null;
  const r15=anchoredReturn(points,15);
  const e20=emaTimed(points.slice(-120),20),e50=emaTimed(points,50);
  const regimeData=classifyMarketRegime(points,r5,r15,anchoredReturn(points,60),e20,e50);
  const trendUp=regimeData.efficiency>=0.24&&regimeData.emaGapPct>=0.035&&e20>e50&&r15>0.06&&r5>0.025;
  const trendDown=regimeData.efficiency>=0.24&&regimeData.emaGapPct>=0.035&&e20<e50&&r15< -0.06&&r5< -0.025;
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
const qualityCode = `    const signalQuality = evaluateSignalQuality({candidate,forecast,market:reviewerMarket,eventIntel});
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
