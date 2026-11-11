import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const file = path.join(process.cwd(), "reconstructed", "patched-worker.js");
let source = await readFile(file, "utf8");

function once(before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(label + ": expected exactly one match, found " + count);
  source = source.replace(before, after);
  console.log("Applied D1 efficiency patch: " + label);
}

once(
  '  lastCoreScalpCandleAt = 0;',
  '  lastCoreScalpCandleAt = 0;\n  coreScalpCandles = {};',
  "keep recent core 1m candles in persistent Durable Object state",
);

once(
  '      this.state.storage.get("lastContextSnapshotPersistAt")',
  '      this.state.storage.get("lastContextSnapshotPersistAt"),\n      this.state.storage.get("coreScalpCandles"),\n      this.state.storage.get("coreTrendCandles")',
  "restore the core scalp candle cache after Durable Object restarts",
);

once(
  '    this.lastContextSnapshotPersistAt = Number(values[21]) || 0;',
  '    this.lastContextSnapshotPersistAt = Number(values[21]) || 0;\n    this.coreScalpCandles = values[22] || {};\n    this.coreTrendCandles = values[23] || {};',
  "hydrate the persisted core scalp candle cache",
);

const methodStart = source.indexOf("  async writeCoreScalpCandles(now) {");
const methodEnd = source.indexOf("  async writeHistory(rows, alerts, now) {", methodStart);
if (methodStart < 0 || methodEnd <= methodStart) throw new Error("Could not locate the bounded core scalp candle writer.");
const method = [
  "  async writeCoreScalpCandles(now) {",
  "    if (now - this.lastCoreScalpCandleAt < 55e3) return;",
  "    this.lastCoreScalpCandleAt = now;",
  '    const symbols = ["BTC", "ETH", "SOL", "BNB", "HYPE", "ZEC"].filter((symbol) => Number(this.latest[symbol]) > 0);',
  "    let updated = false;",
  "    for (let offset = 0; offset < symbols.length; offset += 3) {",
  "      await Promise.all(symbols.slice(offset, offset + 3).map(async (symbol) => {",
  "        try {",
  "          const response = await fetch(HYPERLIQUID_INFO, {",
  '            method: "POST",',
  '            headers: { "content-type": "application/json" },',
  '            body: JSON.stringify({ type: "candleSnapshot", req: { coin: symbol, interval: "1m", startTime: now - 45 * 60e3, endTime: now } }),',
  '            signal: AbortSignal.timeout(8e3)',
  "          });",
  '          if (!response.ok) throw new Error("candleSnapshot HTTP " + response.status);',
  "          const payload = await response.json();",
  "          const candles = (Array.isArray(payload) ? payload : [payload]).filter((c) => {",
  '            if (!c || typeof c !== "object" || Array.isArray(c)) return false;',
  "            const closeAt = Number(c.T || c.t);",
  '            return String(c.s || symbol).toUpperCase() === symbol && String(c.i || "1m") === "1m" &&',
  "              Number(c.t) > 0 && closeAt <= now && [c.o,c.h,c.l,c.c].every((v) => Number.isFinite(Number(v)) && Number(v) > 0);",
  "          }).sort((a,b) => Number(a.t)-Number(b.t));",
  "          const merged = new Map((Array.isArray(this.coreScalpCandles[symbol]) ? this.coreScalpCandles[symbol] : [])",
  "            .map((row) => [Number(row.open_ts_ms), row]));",
  "          for (const candle of candles.slice(-60)) {",
  "            const row = {",
  "              symbol,",
  '              interval: "1m",',
  "              open_ts_ms: Number(candle.t),",
  "              close_ts_ms: Number(candle.T || candle.t),",
  "              open_price: Number(candle.o),",
  "              high_price: Number(candle.h),",
  "              low_price: Number(candle.l),",
  "              close_price: Number(candle.c),",
  "              volume: Number(candle.v) || 0,",
  "              trade_count: Number(candle.n) || 0",
  "            };",
  "            merged.set(row.open_ts_ms, row);",
  "          }",
  "          this.coreScalpCandles[symbol] = [...merged.values()]",
  "            .sort((a,b) => a.open_ts_ms-b.open_ts_ms)",
  "            .slice(-60);",
  "          updated = true;",
  "        } catch (error) {",
  '          console.error("Core scalp 1m candle refresh failed for " + symbol + ": " + String(error).slice(0,160));',
  "        }",
  "      }));",
  "    }",
  "    if (updated) {",
  '      await this.state.storage.put("coreScalpCandles", this.coreScalpCandles).catch((error) =>',
  '        console.error("Core scalp candle state persistence failed: " + String(error).slice(0,160)));',
  "    }",
  "  }",
  ""
].join("\n");
source = source.slice(0, methodStart) + method + source.slice(methodEnd);
console.log("Applied D1 efficiency patch: keep closed 1m candles in Durable Object storage instead of duplicating them in D1");

once(
  "async function runAdvisorCycle(env, prices, now, lastTickAt, priceHistory, liveEvidence, paperStorage) {",
  "async function runAdvisorCycle(env, prices, now, lastTickAt, priceHistory, liveEvidence, paperStorage, coreScalpCandles = {}, coreTrendCandles = {}) {",
  "pass persistent in-memory candle history to the core scalp analyzer",
);

const oldCandleReads = [
  "  const coreCandleResults = await Promise.all(coreScalpSymbols.map(async (symbol) => {",
  "    const [one, five] = await Promise.all([",
  '      env.DB.prepare("SELECT open_ts_ms,close_ts_ms,open_price,high_price,low_price,close_price,volume FROM market_candles WHERE symbol=? AND interval=\'1m\' AND close_ts_ms<=? ORDER BY open_ts_ms DESC LIMIT 60").bind(symbol,now).all(),',
  '      env.DB.prepare("SELECT open_ts_ms,close_ts_ms,open_price,high_price,low_price,close_price,volume FROM market_candles WHERE symbol=? AND interval=\'5m\' AND close_ts_ms<=? ORDER BY open_ts_ms DESC LIMIT 60").bind(symbol,now).all()',
  "    ]);",
  "    return [symbol,(one.results||[]).reverse(),(five.results||[]).reverse()];",
  "  }));"
].join("\n");
const newCandleReads = [
  "  const coreCandleResults = coreScalpSymbols.map((symbol) => {",
  "    const one = Array.isArray(coreScalpCandles?.[symbol]) ? coreScalpCandles[symbol].slice(-60) : [];",
  "    const five = Array.isArray(coreTrendCandles?.[symbol]) ? coreTrendCandles[symbol].filter((row) => Number(row.close_ts_ms) <= now).slice(-60) : [];",
  "    return [symbol,one,five];",
  "  });"
].join("\n");
once(oldCandleReads, newCandleReads, "read 1m candles from DO state and keep only native 5m history in D1");

once(
  "runAdvisorCycle(this.env, this.latest, now, this.lastTickAt, this.history, this.liveMarketInputs(now), this.state.storage);",
  "runAdvisorCycle(this.env, this.latest, now, this.lastTickAt, this.history, this.liveMarketInputs(now), this.state.storage, this.coreScalpCandles, this.coreTrendCandles);",
  "supply the same persisted 1m candles to every advisor cycle",
);


once(
  '  async updateAlertOutcomes(now) {\n    const result = await this.env.DB.prepare(',
  '  async updateAlertOutcomes(now) {\n    const lastUpdate = Number(await this.state.storage.get("lastAlertOutcomeUpdateAt") || 0);\n    if (lastUpdate && now - lastUpdate < 15 * 60 * 1e3) return;\n    const result = await this.env.DB.prepare(',
  "throttle non-critical alert outcome analytics to one D1 read batch every fifteen minutes",
);
once(
  'ORDER BY created_at_ms ASC LIMIT 200',
  'ORDER BY created_at_ms ASC LIMIT 20',
  "bound each alert outcome batch to 20 rows",
);
once(
  '    if (statements.length) await this.env.DB.batch(statements);\n  }\n};',
  '    if (statements.length) await this.env.DB.batch(statements);\n    await this.state.storage.put("lastAlertOutcomeUpdateAt", now);\n  }\n};',
  "persist the alert outcome analytics throttle in Durable Object storage",
);


const trendCandleMethodStart = source.indexOf("  async writeCandleSnapshots(now) {");
const trendCandleMethodEnd = source.indexOf("  async hydrateHistoryFromD1(now) {", trendCandleMethodStart);
if (trendCandleMethodStart < 0 || trendCandleMethodEnd <= trendCandleMethodStart) throw new Error("Could not locate native 5m candle snapshot writer.");
let trendCandleMethod = source.slice(trendCandleMethodStart, trendCandleMethodEnd);
function onceInMethod(from, to, description) {
  const count = trendCandleMethod.split(from).length - 1;
  if (count !== 1) throw new Error("Expected one match for " + description + "; found " + count);
  trendCandleMethod = trendCandleMethod.replace(from, to);
}
onceInMethod('    const statements = [];', '    const statements = [];\n    let coreTrendUpdated = false;', "track 5m cache updates");
onceInMethod('req: { coin: symbol, interval: "5m", startTime, endTime }',
  'req: { coin: symbol, interval: "5m", startTime: (["BTC","ETH","SOL","BNB","HYPE","ZEC"].includes(symbol) && (this.coreTrendCandles[symbol] || []).length < 40) ? now - 5 * 60 * 60 * 1e3 : startTime, endTime }',
  "bootstrap 5h of 5m candles only when the core cache is cold");
onceInMethod('          if (!latestClosed) return;',
  '          if (!latestClosed) return;\n          if (["BTC","ETH","SOL","BNB","HYPE","ZEC"].includes(symbol)) {\n            const merged = new Map((Array.isArray(this.coreTrendCandles[symbol]) ? this.coreTrendCandles[symbol] : []).map((row) => [Number(row.open_ts_ms), row]));\n            for (const candle of valid) {\n              if (candle.closeAt > now) continue;\n              merged.set(candle.openAt, { open_ts_ms: candle.openAt, close_ts_ms: candle.closeAt, open_price: candle.open, high_price: candle.high, low_price: candle.low, close_price: candle.close, volume: candle.volume });\n            }\n            this.coreTrendCandles[symbol] = [...merged.values()].sort((left, right) => left.open_ts_ms - right.open_ts_ms).slice(-60);\n            coreTrendUpdated = true;\n          }',
  "merge fresh closed 5m candles into the persistent DO cache");
onceInMethod('    }\n  }\n', '    }\n    if (coreTrendUpdated) await this.state.storage.put("coreTrendCandles", this.coreTrendCandles).catch((error) => console.error("Core trend candle state persistence failed: " + String(error).slice(0,160)));\n  }\n', "persist the 5m cache once per snapshot batch");
source = source.slice(0, trendCandleMethodStart) + trendCandleMethod + source.slice(trendCandleMethodEnd);


// Keep the 24-hour 5m structure cache in the Hyperliquid Durable Object.
// Advisor scans must not repeatedly read D1 hourly aggregates.
function replaceOnceInSource(before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(label + ": expected exactly one match, found " + count);
  source = source.replace(before, after);
}

const historyFallbackBefore = `  if (priceHistory) {
    for (const symbol of symbols) {
      const points = priceHistory[symbol] || [];
      if (points.length) hist.set(symbol, points.map((point) => ({ symbol, mid_price: Number(point.p), ts_ms: Number(point.t) })));
    }
  } else {
    for (let offset = 0; offset < symbols.length; offset += 5) {
      const chunk = await Promise.all(symbols.slice(offset, offset + 5).map((sym) => env.DB.prepare(
        "SELECT symbol,mid_price,ts_ms FROM market_samples WHERE symbol=? AND ts_ms>=? ORDER BY ts_ms DESC LIMIT 200"
      ).bind(sym, now - 8 * 60 * 60 * 1e3).all()));
      for (let index = 0; index < chunk.length; index++) {
        const rows = (chunk[index].results || []).slice().reverse();
        if (rows.length) hist.set(symbols[offset + index], rows);
      }
    }
  } ;
const historyFallbackAfter = `  for (const symbol of symbols) {
    const points = Array.isArray(priceHistory?.[symbol]) ? priceHistory[symbol] : [];
    if (points.length) hist.set(symbol, points.map((point) => ({ symbol, mid_price: Number(point.p), ts_ms: Number(point.t) })));
  } ;
replaceOnceInSource(historyFallbackBefore, historyFallbackAfter, "use Durable Object price history instead of per-cycle D1 sample reads");

replaceOnceInSource(
  `  await env.DB.prepare("UPDATE advisor_positions SET status='EXPIRED',updated_at_ms=? WHERE status='PROPOSED' AND expires_at_ms<=?").bind(now, now).run();`,
  `  const expirySweepKey = "ciel:advisor:proposal-expiry:last-run";
  const expirySweepAt = Number(await env.CIEL_STATE.get(expirySweepKey).catch(() => 0));
  if (now - expirySweepAt >= 5 * 60e3) {
    await env.CIEL_STATE.put(expirySweepKey, String(now), { expirationTtl: 86400 }).catch(() => void 0);
    await env.DB.prepare("UPDATE advisor_positions SET status='EXPIRED',updated_at_ms=? WHERE status='PROPOSED' AND expires_at_ms<=?").bind(now, now).run();
  }`,
  "throttle proposal expiry sweep to every five minutes"
);

replaceOnceInSource(
  'this.coreTrendCandles[symbol] = [...merged.values()].sort((left, right) => left.open_ts_ms - right.open_ts_ms).slice(-60);',
  'this.coreTrendCandles[symbol] = [...merged.values()].sort((left, right) => left.open_ts_ms - right.open_ts_ms).slice(-288);',
  "retain 24 hours of native 5m candles in the DO cache"
);
replaceOnceInSource(
  'now - 5 * 60 * 60 * 1e3',
  'now - 24 * 60 * 60 * 1e3',
  "bootstrap a full 24-hour 5m candle window"
);
source = source.replaceAll('["BTC","ETH","SOL"].includes(symbol)', '["BTC","ETH","SOL","BNB","HYPE","ZEC"].includes(symbol)');
replaceOnceInSource(
  'var CANDLE_HISTORY_SYMBOLS = /* @__PURE__ */ new Set(["BTC", "ETH", "MON", "SOL"]);',
  'var CANDLE_HISTORY_SYMBOLS = /* @__PURE__ */ new Set(["BTC", "ETH", "MON", "SOL", "BNB", "HYPE", "ZEC"]);',
  "retain native 5m candle history for BNB"
);
replaceOnceInSource(
  'async function runAdvisorCycle(env, prices, now, lastTickAt, priceHistory, liveEvidence, paperStorage, coreScalpCandles = {}, coreTrendCandles = {}) {',
  'async function runAdvisorCycle(env, prices, now, lastTickAt, priceHistory, liveEvidence, paperStorage, coreScalpCandles = {}, coreTrendCandles = {}) {',
  "retain the explicit DO cache advisor signature"
);

// Replace the D1 hourly aggregate reader with a pure in-memory aggregation.
const levelStart = source.indexOf("async function getCandleStructureMap(env,symbols,now){");
const levelEnd = source.indexOf("function analyzeCandleLevelReversal", levelStart);
if (levelStart < 0 || levelEnd <= levelStart) throw new Error("Could not locate candle structure map.");
const levelHelper = [
  "function aggregateCachedCandleLevels(candles, now) {",
  "  const rows = (Array.isArray(candles) ? candles : []).filter((c) => Number(c?.close_ts_ms) <= now && Number(c?.open_ts_ms) > 0 && Number(c?.low_price) > 0 && Number(c?.high_price) >= Number(c?.low_price));",
  "  if (!rows.length) return null;",
  "  const byHour = new Map();",
  "  for (const c of rows) {",
  "    const bucket = Math.floor(Number(c.open_ts_ms) / 36e5) * 36e5;",
  "    const current = byHour.get(bucket) || { bucket_ms: bucket, low_price: Infinity, high_price: -Infinity };",
  "    current.low_price = Math.min(current.low_price, Number(c.low_price));",
  "    current.high_price = Math.max(current.high_price, Number(c.high_price));",
  "    byHour.set(bucket, current);",
  "  }",
  "  const hours = [...byHour.values()].sort((a,b) => a.bucket_ms-b.bucket_ms);",
  "  if (!hours.length) return null;",
  "  const hour = Math.floor(now / 36e5) * 36e5;",
  "  const current = hours.find((x) => x.bucket_ms === hour);",
  "  const prior = hours.find((x) => x.bucket_ms === hour - 36e5);",
  "  return { dayLow: Math.min(...rows.map((x) => Number(x.low_price))), dayHigh: Math.max(...rows.map((x) => Number(x.high_price))),",
  "    currentHourLow: current?.low_price ?? null, currentHourHigh: current?.high_price ?? null,",
  "    priorHourLow: prior?.low_price ?? null, priorHourHigh: prior?.high_price ?? null,",
  "    latestBucket: hours[hours.length-1].bucket_ms, buckets: hours.length };",
  "}",
  "function getCandleStructureMap(env,symbols,now,coreTrendCandles={}) {",
  "  const output = new Map();",
  "  for (const symbol of [...new Set(symbols)].filter(Boolean)) {",
  "    const levels = aggregateCachedCandleLevels(coreTrendCandles?.[symbol], now);",
  "    if (levels) output.set(String(symbol).toUpperCase(), levels);",
  "  }",
  "  return output;",
  "}",
  "__name(getCandleStructureMap,\"getCandleStructureMap\");",
  ""
].join("\n");
source = source.slice(0, levelStart) + levelHelper + source.slice(levelEnd);

// Replace per-candidate D1 hourly query with the same cached candle aggregation.
const evidenceStart = source.indexOf("async function getCandleStructureEvidence(env,symbol,now,currentPrice){");
const evidenceEnd = source.indexOf("async function review(", evidenceStart);
if (evidenceStart < 0 || evidenceEnd <= evidenceStart) throw new Error("Could not locate candle structure evidence reader.");
const evidence = [
  "function getCandleStructureEvidence(env,symbol,now,currentPrice,coreTrendCandles=[]) {",
  "  const empty={available:false,symbol,reason:\"Hourly candle levels are not yet available.\"};",
  "  const row=aggregateCachedCandleLevels(coreTrendCandles,now), price=Number(currentPrice);",
  "  const dayLow=Number(row?.dayLow),dayHigh=Number(row?.dayHigh),latestBucket=Number(row?.latestBucket);",
  "  if (!(dayLow>0&&dayHigh>dayLow&&price>0&&latestBucket>0)||now-latestBucket>2*36e5||Number(row?.buckets)<12) return {...empty,reason:\"24h hourly-candle coverage is incomplete or stale.\"};",
  "  const currentHourLow=Number(row.currentHourLow),currentHourHigh=Number(row.currentHourHigh),priorHourLow=Number(row.priorHourLow),priorHourHigh=Number(row.priorHourHigh);",
  "  const pctAway=(level)=>Number.isFinite(level)&&level>0?(price/level-1)*100:null;",
  "  const highDistance=pctAway(dayHigh),lowDistance=pctAway(dayLow),rangePositionPct=(price-dayLow)/(dayHigh-dayLow)*100,proximity=(v)=>v!==null&&Math.abs(v)<=0.15;",
  "  return {available:true,symbol,source:\"Hyperliquid 5m candles aggregated in HyperliquidFeed Durable Object memory\",asOfBucketMs:latestBucket,coverageHours:Number(row.buckets),",
  "    day24h:{high:dayHigh,low:dayLow,positionPct:Math.max(0,Math.min(100,rangePositionPct)),distanceToHighPct:highDistance,distanceToLowPct:lowDistance,nearHigh:proximity(highDistance),nearLow:proximity(lowDistance)},",
  "    currentHour:{high:Number.isFinite(currentHourHigh)?currentHourHigh:null,low:Number.isFinite(currentHourLow)?currentHourLow:null},",
  "    previousHour:{high:Number.isFinite(priorHourHigh)?priorHourHigh:null,low:Number.isFinite(priorHourLow)?priorHourLow:null,distanceToHighPct:pctAway(priorHourHigh),distanceToLowPct:pctAway(priorHourLow)},",
  "    interpretation:\"Use prior-hour and 24h extremes as support/resistance, breakout, liquidity-sweep and reclaim context. Levels are sampled 5m-candle aggregates, not tick-perfect exchange marks.\"};",
  "}",
  "__name(getCandleStructureEvidence,\"getCandleStructureEvidence\");",
  ""
].join("\n");
source = source.slice(0, evidenceStart) + evidence + source.slice(evidenceEnd);

replaceOnceInSource(
  "const candleStructureRows = await getCandleStructureMap(env,symbols,now);",
  "const candleStructureRows = getCandleStructureMap(env,symbols,now,coreTrendCandles);",
  "derive market-wide hourly levels from DO cache"
);
replaceOnceInSource(
  "const candleStructure = await getCandleStructureEvidence(env,candidate.symbol,now,candidate.entry);",
  "const candleStructure = getCandleStructureEvidence(env,candidate.symbol,now,candidate.entry,coreTrendCandles?.[candidate.symbol]);",
  "derive candidate hourly levels from DO cache"
);

// Live order-book and derivatives evidence is already held in the DO.
// If it is stale, fail closed instead of querying D1 on every candidate.
const marketEvidenceStart = source.indexOf("async function getMarketEvidence(env, symbol, now, live) {");
const marketEvidenceEnd = source.indexOf("__name(getMarketEvidence", marketEvidenceStart);
if (marketEvidenceStart < 0 || marketEvidenceEnd <= marketEvidenceStart) throw new Error("Could not locate market evidence reader.");
let marketEvidence = source.slice(marketEvidenceStart, marketEvidenceEnd);
const fallbackStart = marketEvidence.indexOf("  } else {");
const fallbackEnd = marketEvidence.indexOf("\n  }\n  if (!Object.values(market).every(Number.isFinite))", fallbackStart);
if (fallbackStart < 0 || fallbackEnd <= fallbackStart) throw new Error("Could not locate D1 market evidence fallback.");
marketEvidence = marketEvidence.slice(0,fallbackStart) +
  '  } else { return { market: null, reason: "Fresh Durable Object derivatives and order-book evidence is missing." };' +
  marketEvidence.slice(fallbackEnd);
source = source.slice(0,marketEvidenceStart) + marketEvidence + source.slice(marketEvidenceEnd);

// Replace the mode-specific unindexed D1 AI-audit cooldown lookup with KV.
const priorReviewStart = source.indexOf("    const priorReviewSql = candidate.mode === \"CORE_PULLBACK_SCALP\"");
const qualityReadAt = source.indexOf("    const quality = await getMarketEvidence(env, candidate.symbol, now, liveEvidence?.[candidate.symbol]);", priorReviewStart);
if (priorReviewStart < 0 || qualityReadAt <= priorReviewStart) throw new Error("Could not locate the mode-specific advisor cooldown query.");
const kvCooldown = [
  '    const reviewCooldownKey = candidate.mode === "CORE_PULLBACK_SCALP" || candidate.mode === "CORE_TREND_CONTINUATION" ? "ciel:advisor:review:core:" + candidate.symbol : "ciel:advisor:review:ai:" + candidate.symbol;',
  '    const priorReviewAt = Number(await env.CIEL_STATE.get(reviewCooldownKey)) || 0;',
  '    if (priorReviewAt && now - priorReviewAt < cooldownMs) { console.info("CIEL_ADVISOR_REJECT " + JSON.stringify({symbol:candidate.symbol,reason:"SYMBOL_REVIEW_COOLDOWN",remainingMs:cooldownMs-(now-priorReviewAt)})); continue; }',
  ''
].join("\n");
source = source.slice(0, priorReviewStart) + kvCooldown + source.slice(qualityReadAt);
replaceOnceInSource(
  '    const reviewed = candidate.mode === "CORE_PULLBACK_SCALP"',
  '    await env.CIEL_STATE.put(reviewCooldownKey, String(now), { expirationTtl: 86400 }).catch(() => void 0);\n    const reviewed = candidate.mode === "CORE_PULLBACK_SCALP"',
  "persist the per-symbol cooldown only when a candidate reaches review"
);

replaceOnceInSource(
  '    if (isScalpMode && eventIntel?.marketImpact === "BROAD_RISK_OFF") continue;',
  '    if (isScalpMode && eventIntel?.marketImpact === "BROAD_RISK_OFF") { console.info("CIEL_ADVISOR_REJECT " + JSON.stringify({symbol:candidate.symbol,reason:"BROAD_RISK_OFF_RANGE_SCALP"})); continue; }',
  "log explicit broad-risk-off candidate rejections"
);
source = source.replaceAll(
  'console.log("Ciel skipped " + candidate.symbol + ": " + reason);',
  'console.info("CIEL_ADVISOR_REJECT " + JSON.stringify({symbol:candidate.symbol,reason})); console.log("Ciel skipped " + candidate.symbol + ": " + reason);'
);
// Warm the persisted DO price history once daily, not every ten minutes.
replaceOnceInSource(
  'now - this.lastHistoryHydrationAt < 10 * 60 * 1e3',
  'now - this.lastHistoryHydrationAt < 24 * 60 * 60 * 1e3',
  "reduce D1 history warm-up reads to once daily"
);

await writeFile(file, source);
console.log("D1 efficiency patch complete: the core scalp still receives fresh closed 1m candles every minute; its candle cache is Durable Object-persistent, and D1 retains 5m history and all other market history.");
