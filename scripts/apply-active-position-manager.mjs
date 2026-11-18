import { readFile, writeFile } from "node:fs/promises";

const workerPath = "reconstructed/patched-worker.js";
const marker = "/* CIEL_ACTIVE_POSITION_MANAGER_V1 */";
let worker = await readFile(workerPath, "utf8");
if (worker.includes(marker)) {
  console.log("Adaptive position manager already applied to reconstructed Worker.");
  process.exit(0);
}
const [helperSource, queueSource] = await Promise.all([
  readFile("src/adaptive-market-position.js", "utf8"),
  readFile("src/position-reversal-queue.js", "utf8"),
]);
const paperBody = "async function managePaperTrades(storage,prices,now,lastTickAt,env,books={}) {\n if(!storage||!lastTickAt||now-lastTickAt>MAX_AGE||!(Number(prices.MON)>0))return;\n const closed=[],extended=[];\n await storage.transaction(async()=>{\n  let state=await storage.get(PAPER_ACCOUNT_KEY);if(!state||!Array.isArray(state.trades))return;\n  let changed=false;\n  for(const t of state.trades){\n   if(t.status!==\"OPEN\")continue;\n   const current=Number(prices[t.symbol]),entry=Number(t.entryPrice);if(!(current>0&&entry>0))continue;\n   const dir=t.side===\"SHORT\"?-1:1,move=dir*((current-entry)/entry)*100,stop=Number(t.stopPrice)||0;\n   let reason=null,exit=current,decision=null;\n   const stopHit=stop>0&&(dir===1?current<=stop:current>=stop);\n   if(stopHit)reason=dir===1?(stop>=entry?\"PROFIT_LOCKED_TRAILING_STOP\":\"EMERGENCY_STOP_LOSS\"):(stop<=entry?\"PROFIT_LOCKED_TRAILING_STOP\":\"EMERGENCY_STOP_LOSS\");\n   else{\n    const book=books?.[t.symbol],fresh=Boolean(book&&Number(book.ts_ms)>0&&now-Number(book.ts_ms)>=0&&now-Number(book.ts_ms)<=180000);\n    const bid=fresh?Number(book.bid_size)||0:0,ask=fresh?Number(book.ask_size)||0:0;\n    const imbalance=bid>0&&ask>0&&(t.side===\"LONG\"?bid/ask<.35:ask/bid<.35);\n    decision=evaluateAdaptiveMarketPosition({side:t.side,entryPrice:entry,currentPrice:current,stopPrice:stop,targetPrice:0,\n      state:t.marketManagerState||{},now,liquidityImbalance:imbalance,sampleLimit:16,sampleIntervalMs:45000});\n    if(decision.state)t.marketManagerState=decision.state;\n    if(decision.action===\"UPDATE_LEVELS\"){\n     const ns=Number(decision.stopPrice)||stop;\n     if(ns>0)t.stopPrice=ns;\n     t.stopPct=ns>0?Math.abs((ns/entry-1)*100):Number(t.stopPct||0);\n     t.targetIsAdvisory=true;changed=true;\n    }else if(decision.action===\"CLOSE\"){\n     reason=decision.reason===\"ADAPTIVE_PROFIT_REVERSAL\"?\"MARKET_REVERSAL_EXIT\":\n      decision.reason===\"ADAPTIVE_ADVERSE_CUT\"?\"ADAPTIVE_ADVERSE_CUT\":decision.reason===\"HARD_STOP_TRIGGERED\"?\"STOP_LOSS\":\"TAKE_PROFIT\";\n    }\n    if(!reason&&now>=Number(t.expiresAtMs)){\n     if(Number(decision.closeScore||0)>=4&&move<0)reason=\"MAX_HOLD_ADVERSE_CLOSE\";\n     else{t.maxHoldExtensions=Math.max(0,Number(t.maxHoldExtensions)||0)+1;t.expiresAtMs=now+3600000;t.lastHoldExtensionAtMs=now;extended.push(t.symbol);changed=true}\n    }\n   }\n   if(decision?.state)changed=true;if(!reason)continue;\n   const pnl=paperTradePnl(t,exit,Number(prices.MON));if(!pnl)continue;\n   const pnlMon=Math.max(-Number(t.marginMon),pnl.mon),pnlUsd=pnlMon*Number(prices.MON);\n   state.availableBalanceMon=Number(state.availableBalanceMon||0)+Number(t.marginMon)+pnlMon;\n   state.realizedPnlMon=Number(state.realizedPnlMon||0)+pnlMon;state.realizedPnlUsd=Number(state.realizedPnlUsd||0)+pnlUsd;\n   state.closedCount=Number(state.closedCount||0)+1;if(pnlMon>0)state.wins=Number(state.wins||0)+1;else if(pnlMon<0)state.losses=Number(state.losses||0)+1;else state.breakeven=Number(state.breakeven||0)+1;\n   t.status=\"CLOSED\";t.exitPrice=exit;t.exitMonUsd=Number(prices.MON);t.closedAtMs=now;t.closeReason=reason;\n   t.grossPnlMon=Number.isFinite(Number(pnl.grossMon))?pnl.grossMon:pnlMon;t.grossPnlUsd=Number.isFinite(Number(pnl.grossUsd))?pnl.grossUsd:pnlUsd;\n   t.feeMon=Number(pnl.feeMon)||0;t.feeUsd=Number(pnl.feeUsd)||0;t.netPnlMon=pnlMon;t.netPnlUsd=pnlMon*Number(prices.MON);\n   t.feeModelVersion=\"LEVERUP_TAKER_3BPS_EACH_SIDE_V1\";t.returnOnMarginPct=Number(t.marginMon)>0?pnlMon/Number(t.marginMon)*100:0;\n   closed.push({symbol:t.symbol,side:t.side,signalId:t.signalId,reason,exitPrice:exit,pnlMon,pnlUsd,roiPct:t.returnOnMarginPct,\n     reverseConfirmed:decision?.reverseConfirmed===true});changed=true;\n  }\n  if(changed){state.trades=state.trades.slice(0,1000);state.updatedAtMs=now;await storage.put(PAPER_ACCOUNT_KEY,state)}\n });\n for(const t of closed.filter(x=>x.reverseConfirmed))await enqueueCielPositionReversal(env,{id:\"paper:\"+String(t.signalId),source:\"PAPER\",signalId:t.signalId,\n   symbol:t.symbol,previousSide:t.side,side:t.side===\"LONG\"?\"SHORT\":\"LONG\",reason:t.reason,status:\"CLOSE_CONFIRMED\"},now,false);\n if((closed.length||extended.length)&&env){\n  const sign=v=>(v>=0?\"+\":\"\")+v.toFixed(3),lines=[];if(closed.length)lines.push(\"🧪 PAPER TRADE CLOSED\");\n  for(const t of closed){lines.push(t.side+\" \"+t.symbol+\" | \"+t.reason,\"Simulated exit $\"+fmt(t.exitPrice)+\" | NET P&L \"+sign(t.pnlMon)+\" MON ($\"+sign(t.pnlUsd)+\")\",\n    \"Estimated entry+exit fees deducted; return on margin: \"+sign(t.roiPct)+\"%\");\n   if(t.reverseConfirmed)lines.push(\"Reversal confirmed; fresh opposite-side setup and normal checks required before re-entry.\")}\n  if(extended.length)lines.push(\"Position review window extended 60 minutes because the strategy has not confirmed an exit; emergency stop remains active.\");\n  lines.push(\"Paper P&L deducts estimated 3 bps per side; funding, holding fees, oracle costs, slippage and liquidation remain excluded.\");\n  await sendTelegram(env,lines.join(\"\\n\")).catch(()=>void 0);\n }\n}\n__name(managePaperTrades, \"managePaperTrades\");";
const queueFunctions = "\nasync function readCielPositionReversalQueue(env, now=Date.now()) {\n if(!env?.CIEL_STATE?.get)return [];\n let q=await env.CIEL_STATE.get(CIEL_POSITION_REVERSAL_QUEUE_KEY,\"json\").catch(()=>[]);\n if(typeof q===\"string\"){try{q=JSON.parse(q)}catch{q=[]}}\n return normalizePositionReversalQueue(q,now);\n}\nasync function writeCielPositionReversalQueue(env,q) {\n if(!env?.CIEL_STATE?.put)return false;\n await env.CIEL_STATE.put(CIEL_POSITION_REVERSAL_QUEUE_KEY,JSON.stringify(q),{expirationTtl:6*3600}).catch(()=>void 0);\n return true;\n}\nasync function updateCielPositionReversalQueue(env,id,patch,now=Date.now()) {\n const q=await readCielPositionReversalQueue(env,now),u=updatePositionReversalRequest(q,id,patch,now);\n if(!u.changed)return false;\n await writeCielPositionReversalQueue(env,u.queue);return true;\n}\nasync function enqueueCielPositionReversal(env,r,now=Date.now(),notify=true) {\n if(!env?.CIEL_STATE?.get||!r?.symbol||!r?.side)return false;\n const q=await readCielPositionReversalQueue(env,now),id=String(r.id||(String(r.source||\"LIVE\").toLowerCase()+\":\"+String(r.positionHash||r.signalId||now)));\n if(q.some(x=>x.id===id))return false;\n q.push({id,source:String(r.source||\"LIVE\"),positionHash:r.positionHash?String(r.positionHash).toLowerCase():\"\",\n tradeId:r.tradeId||null,signalId:r.signalId||null,symbol:String(r.symbol).toUpperCase(),previousSide:r.previousSide||null,\n side:String(r.side).toUpperCase(),reason:String(r.reason||\"CONFIRMED_MARKET_REVERSAL\"),status:String(r.status||\"WAITING_CLOSE_CONFIRMATION\"),\n requestedAt:Number(now),expiresAt:Number(now)+7200000,nextAttemptAt:Number(now)});\n await writeCielPositionReversalQueue(env,q);\n if(notify)await sendTelegram(env,\"♻️ CIEL REVERSAL WATCH QUEUED\\n\"+String(r.symbol).toUpperCase()+\" \"+String(r.previousSide||\"POSITION\")+\" → \"+String(r.side).toUpperCase()+\n \"\\nClose submitted. No opposite entry without closure confirmation and a fresh CIEL setup.\").catch(()=>void 0);\n return true;\n}\nasync function advanceCielPositionReversalQueue(env,positionMap,entries,now=Date.now()) {\n if(!env?.CIEL_STATE?.get||!env?.CIEL_STATE?.put)return;\n const q=await readCielPositionReversalQueue(env,now);\n const rows=[...positionMap.values()].map(p=>{const e=entries.find(x=>String(x.positionHash||\"\").toLowerCase()===String(p.positionHash||\"\").toLowerCase());\n return {positionHash:p.positionHash,symbol:p.symbol||p.pairSymbol||p.purgeSymbol||\"\",side:p.isLong?\"LONG\":\"SHORT\",signalId:e?.signalId||\"\"}});\n const u=reconcilePositionReversalQueue(q,rows,now);if(!u.changed)return;\n for(const x of u.queue)if(x.status===\"CLOSE_CONFIRMED\"&&!x.closeNoticeSentAt){x.closeNoticeSentAt=Number(now);\n await sendTelegram(env,\"♻️ CIEL REVERSAL CLOSE CONFIRMED\\n\"+x.symbol+\" old position is absent on-chain. Waiting for a fresh \"+x.side+\" setup; normal checks still apply.\").catch(()=>void 0)}\n await writeCielPositionReversalQueue(env,u.queue);\n}";

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(label + ": expected exactly one anchor, found " + count);
  return source.replace(needle, replacement);
}
function replaceFunction(source, startNeedle, endMarker, replacement, label) {
  const start = source.indexOf(startNeedle);
  if (start < 0) throw new Error(label + ": start missing");
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(label + ": end marker missing");
  return source.slice(0, start) + replacement + source.slice(end);
}
const stripExports = (value) => value.replace(/^export\s+(?=(?:const|function|async function|class)\b)/gm, "");
const helperInline = stripExports(helperSource)
  .replace(/\bclamp\b/g, "adaptiveMarketClamp")
  .replace(/\bfinitePositive\b/g, "adaptiveMarketFinitePositive");
const queueInline = stripExports(queueSource).replace(/\bactiveStates\b/g, "positionReversalActiveStates");

// The live manager is a source module imported by the reconstructed Worker.
// Do not try to rewrite it as an inline function in the generated bundle.
const coordinatorImport = 'import { runLeverUpPositionManager } from "../src/leverup-coordinator.js";';
if (!worker.includes(coordinatorImport)) throw new Error("Source-module import for the live LeverUp manager is missing.");
const coordinatorSource = await readFile("src/leverup-coordinator.js", "utf8");
const liveManagerStart = coordinatorSource.indexOf("export async function runLeverUpPositionManager(");
if (liveManagerStart < 0 || !coordinatorSource.slice(liveManagerStart).includes("hyperliquidPriceRawForPosition(position, marketData.markets)")) {
  throw new Error("Exported Hyperliquid-led live manager implementation is missing or incomplete.");
}
if (coordinatorSource.slice(liveManagerStart).includes("(dependencies.fetchPrices || fetchLatestOraclePrices)")) {
  throw new Error("Live manager must not poll LeverUp oracle prices.");
}
worker = replaceOnce(worker, "async function managePaperTrades(",
  marker + "\n" + helperInline + "\n" + queueInline + "\n" + queueFunctions + "\nasync function managePaperTrades(",
  "inline shared adaptive evaluator and reversal queue for paper management; live manager remains source-module-owned");
worker = replaceFunction(worker, "async function managePaperTrades(",
  "async function getPaperSummary(", paperBody.replace(/\n__name\(managePaperTrades, "managePaperTrades"\);$/, ""),
  "replace paper trade manager with adaptive position lifecycle");
worker = replaceOnce(worker,
  'await managePaperTrades(this.state.storage, this.latest, now, this.lastTickAt, this.env);',
  'await managePaperTrades(this.state.storage, this.latest, now, this.lastTickAt, this.env, this.latestBooks);',
  "reuse current Hyperliquid order-book snapshots");

const advisorStart = worker.indexOf("async function runAdvisorCycle(");
const loopAnchor = "  for (const candidate of candidates) {";
const firstLoop = worker.indexOf(loopAnchor, advisorStart);
if (advisorStart < 0 || firstLoop < 0) throw new Error("Advisor candidate-loop anchor missing");
const matchBlock = '  const activeReversalQueue = await readCielPositionReversalQueue(env, now);\n' +
  '  let reversalQueueChanged = false;\n' +
  '  for (const candidate of candidates) { const request = matchPositionReversalRequest(activeReversalQueue, candidate, now); if (request) { candidate.reversalRequestId = request.id; request.lastCandidateAt = now; request.nextAttemptAt = now + 300000; reversalQueueChanged = true; } }\n' +
  '  if (reversalQueueChanged) await writeCielPositionReversalQueue(env, activeReversalQueue, now);\n' +
  '  const candidateProcessingOrder = candidates.slice().sort((a,b)=>Number(Boolean(b.reversalRequestId))-Number(Boolean(a.reversalRequestId)));\n';
worker = worker.slice(0, firstLoop) + matchBlock + worker.slice(firstLoop);
const executionLoop = worker.indexOf(loopAnchor, firstLoop + matchBlock.length);
if (executionLoop < 0) throw new Error("Advisor execution-loop anchor missing");
worker = worker.slice(0, executionLoop) + "  for (const candidate of candidateProcessingOrder) {" + worker.slice(executionLoop + loopAnchor.length);
worker = replaceOnce(worker,
  'if (priorReviewAt && now - priorReviewAt < cooldownMs) {',
  'if (priorReviewAt && now - priorReviewAt < cooldownMs && !candidate.reversalRequestId) {',
  "allow queued reversal candidate to receive a fresh review");
const liveEntryMarker = "liveEntrySubmittedThisCycle = true;";
const liveEntryAt = worker.indexOf(liveEntryMarker, advisorStart);
if (liveEntryAt < 0 || worker.indexOf(liveEntryMarker, liveEntryAt + liveEntryMarker.length) >= 0) {
  throw new Error("Expected exactly one live-entry submission state update in advisor cycle");
}
const liveEntryAfter = liveEntryAt + liveEntryMarker.length;
worker = worker.slice(0, liveEntryAfter) +
  '\n    if(candidate.reversalRequestId){const sent=leverUpPlan?.coordination?.submitted===true||["SUBMITTED","EXECUTED","RECONCILED","PENDING","UNCERTAIN"].includes(String(leverUpPlan?.coordination?.status||"").toUpperCase());if(sent)await updateCielPositionReversalQueue(env,candidate.reversalRequestId,{status:"ENTRY_SUBMITTED",entrySignalId:id,submittedAt:now,live:true},now);}' +
  worker.slice(liveEntryAfter);
worker = replaceOnce(worker, '      const leverUpLine = formatLeverUpAdvisorLine(leverUpPlan);',
  '      if(candidate.reversalRequestId && paperResult?.opened) await updateCielPositionReversalQueue(env,candidate.reversalRequestId,{status:"COMPLETED",paperOpenedAt:now,paperSignalId:id},now);\n      const leverUpLine = formatLeverUpAdvisorLine(leverUpPlan);',
  "record opened paper reversal entry");
const rationaleAnchor = 'const rationale = candidate.reason + " " + forecastSummary + " " + reviewSummary + timingSummary';
worker = replaceOnce(worker, rationaleAnchor,
  'const rationale = (candidate.reversalRequestId ? "Confirmed reversal follow-through: previous position is closed; fresh opposite setup still requires normal checks. " : "") + candidate.reason + " " + forecastSummary + " " + reviewSummary + timingSummary',
  "annotate reversal proposal");

await writeFile(workerPath, worker);
console.log("Applied CIEL adaptive market-aware exits and confirmed reversal lifecycle to reconstructed/patched-worker.js.");
