import { readFile, writeFile } from "node:fs/promises";

const file = "reconstructed/patched-worker.js";
let source = await readFile(file, "utf8");

function replaceOnce(text, before, after, label) {
  const count = text.split(before).length - 1;
  if (count !== 1) throw new Error(label + ": expected exactly one match, found " + count);
  return text.replace(before, after);
}

function replaceRegexOnce(text, pattern, replacement, label) {
  const globalPattern = pattern.global ? pattern : new RegExp(pattern.source, pattern.flags + "g");
  const matches = [...text.matchAll(globalPattern)];
  if (matches.length !== 1) throw new Error(label + ": expected exactly one match, found " + matches.length);
  return text.replace(pattern, replacement);
}

source = replaceOnce(
  source,
  '    this.orderFlow = values[22] || {};\n    this.coreScalpCandles = values[22] || {};\n    this.coreTrendCandles = values[23] || {};\n    this.xyzQntMid = values[24] || null;\n    this.lastXyzQntRefreshAt = Number(values[25]) || 0;\n    this.historyBootstrapDone = values[26] === true;\n    this.lastHistoryBootstrapAt = Number(values[27]) || 0;',
  '    this.orderFlow = values[22] || {};\n    this.coreScalpCandles = values[23] || {};\n    this.coreTrendCandles = values[24] || {};\n    this.xyzQntMid = values[25] || null;\n    this.lastXyzQntRefreshAt = Number(values[26]) || 0;\n    this.historyBootstrapDone = values[27] === true;\n    this.lastHistoryBootstrapAt = Number(values[28]) || 0;',
  "fix Durable Object state restore indexes",
);

source = replaceRegexOnce(source, /const tableStats = \{\};[\s\S]*?const feed = await feedStatus\(env\);/, "const statsCacheKey = \"ciel:api:diagnostics:table-stats:v1\";\n        const statsCacheNow = Date.now();\n        const cachedStats = await env.CIEL_STATE.get(statsCacheKey, \"json\").catch(() => null);\n        const statsFresh = Boolean(cachedStats && statsCacheNow - Number(cachedStats.at || 0) < 10 * 60 * 1e3);\n        const tableStats = statsFresh ? cachedStats.tableStats || {} : {};\n        if (!statsFresh) {\n          const statsQueries = { market_samples: \"SELECT COUNT(*) AS rows,MIN(ts_ms) AS first_ts,MAX(ts_ms) AS last_ts FROM market_samples\", market_candles: \"SELECT COUNT(*) AS rows,MIN(open_ts_ms) AS first_ts,MAX(open_ts_ms) AS last_ts FROM market_candles\", market_context_snapshots: \"SELECT COUNT(*) AS rows,MIN(ts_ms) AS first_ts,MAX(ts_ms) AS last_ts FROM market_context_snapshots\", market_candle_hourly_stats: \"SELECT COUNT(*) AS rows,MIN(bucket_ms) AS first_ts,MAX(bucket_ms) AS last_ts FROM market_candle_hourly_stats\", market_alerts: \"SELECT COUNT(*) AS rows,MIN(created_at_ms) AS first_ts,MAX(created_at_ms) AS last_ts FROM market_alerts\", advisor_ai_audit: \"SELECT COUNT(*) AS rows,MIN(created_at_ms) AS first_ts,MAX(created_at_ms) AS last_ts FROM advisor_ai_audit\" };\n          for (const [name, sql] of Object.entries(statsQueries)) {\n            if (!tables.includes(name)) {\n              tableStats[name] = null;\n              continue;\n            }\n            try {\n              tableStats[name] = await env.DB.prepare(sql).first();\n            } catch (error) {\n              tableStats[name] = { error: String(error).slice(0, 160) };\n            }\n          }\n          await env.CIEL_STATE.put(statsCacheKey, JSON.stringify({ at: statsCacheNow, tableStats }), { expirationTtl: 3600 }).catch(() => void 0);\n        }\n        const feed = await feedStatus(env);", "cache diagnostics table counts for ten minutes");

source = replaceRegexOnce(source, /const persist = new Set\(this\.persistedSymbols\(now\)\);[\s\S]*?for \(const alert of alerts\) \{/, "      if (!this.marketSampleStateLoaded) {\n        const [sampleTimes, wideSlot] = await Promise.all([this.state.storage.get(\"lastSampleAtBySymbol\"), this.state.storage.get(\"lastWideSampleSlot\")]);\n        this.lastSampleAtBySymbol = sampleTimes && typeof sampleTimes === \"object\" ? sampleTimes : {};\n        this.lastWideSampleSlot = Number(wideSlot) || 0;\n        this.marketSampleStateLoaded = true;\n      }\n      const persist = new Set(this.persistedSymbols(now));\n      // Keep 1m signal candles in DO memory. Persist benchmark samples once per minute\n      // and the wider watchlist once per 10-minute slot.\n      const wideSampleSlot = Math.floor(now / (10 * 60 * 1e3));\n      const persistAllSamples = this.lastWideSampleSlot !== wideSampleSlot;\n      const nextSampleAtBySymbol = { ...(this.lastSampleAtBySymbol || {}) };\n      const sampledWideSymbols = new Set();\n      let wideSamplesWritten = false;\n      const sampleRows = rows.filter((row) => {\n        if (!persist.has(row.symbol)) return false;\n        if (BENCHMARK_PRICE_SYMBOLS.has(row.symbol)) {\n          if (now - Number(nextSampleAtBySymbol[row.symbol] || 0) < SAMPLE_INTERVAL_MS) return false;\n          nextSampleAtBySymbol[row.symbol] = now;\n          return true;\n        }\n        if (!persistAllSamples || sampledWideSymbols.has(row.symbol)) return false;\n        sampledWideSymbols.add(row.symbol);\n        wideSamplesWritten = true;\n        return true;\n      });\n      const statements = sampleRows.map((row) => this.env.DB.prepare(\n        \"INSERT OR REPLACE INTO market_samples (ts_ms, symbol, mid_price) VALUES (?, ?, ?)\"\n      ).bind(row.t, row.symbol, row.price));\n      for (const alert of alerts) {", "throttle benchmark and wide sample writes");
// The recovered feed already persists sample throttle state after the D1 batch.

const methodStart = source.indexOf("  async writeCoreScalpCandles(now) {");
const methodEnd = source.indexOf("  async writeHistory(rows, alerts, now) {", methodStart);
if (methodStart < 0 || methodEnd <= methodStart) throw new Error("Core scalp candle writer boundaries missing.");

let method = source.slice(methodStart, methodEnd);
method = replaceOnce(
  method,
  '    const symbols = ["BTC", "ETH", "SOL", "BNB", "HYPE", "ZEC", "ADA", "PUMP"].filter((symbol) => Number(this.latest[symbol]) > 0);',
  '    const minLeverage = Number(this.env?.LEVERUP_MIN_LEVERAGE || 50);\n    const symbols = ["BTC", "ETH", "SOL", "BNB", "HYPE", "ZEC", "ADA", "PUMP"].filter((symbol) => Number(LEVERUP_MARKET_MAX_LEVERAGE[symbol]) >= minLeverage);',
  "fetch 1m candles only for markets executable at the configured leverage floor",
);
method = replaceOnce(
  method,
  '        try {\n          const response = await fetch(HYPERLIQUID_INFO, {',
  '        try {\n          const existing = Array.isArray(this.coreScalpCandles[symbol]) ? this.coreScalpCandles[symbol] : [];\n          const oldest = Number(existing[0]?.open_ts_ms || 0);\n          const needsBootstrap = existing.length < 180 || oldest > now - 175 * 6e4;\n          const lookbackMinutes = needsBootstrap ? 210 : 15;\n          const response = await fetch(HYPERLIQUID_INFO, {',
  "bootstrap enough 1m samples for the local forecast",
);
method = replaceRegexOnce(method, /startTime:\s*now\s*-\s*75\s*\*\s*(?:60e3|6e4)/, "startTime: now - lookbackMinutes * 6e4", "use 210m bootstrap and 15m rolling candle fetches");
method = replaceRegexOnce(
  method,
  /const merged = new Map\(\(Array\.isArray\(this\.coreScalpCandles\[symbol\]\) \? this\.coreScalpCandles\[symbol\] : \[\]\)\s*\.map\(\(row\) => \[Number\(row\.open_ts_ms\), row\]\)\);/,
  "const merged = new Map(existing.map((row) => [Number(row.open_ts_ms), row]));",
  "merge rolling candles into the persistent cache",
);
const capCount = method.split(".slice(-90)").length - 1;
if (capCount !== 2) throw new Error("Expected two 90-candle caps, found " + capCount);
method = method.replaceAll(".slice(-90)", ".slice(-240)");
method = replaceOnce(
  method,
  "const merged = new Map(existing.map((row) => [Number(row.open_ts_ms), row]));",
  'if (!candles.length && !existing.length) {\n            const lastEmptyLog = Number(this.coreScalpCandleEmptyLogAt?.[symbol] || 0);\n            if (now - lastEmptyLog > 5 * 60 * 1e3) {\n              this.coreScalpCandleEmptyLogAt = { ...(this.coreScalpCandleEmptyLogAt || {}), [symbol]: now };\n              console.warn("CIEL_CORE_SCALP_1M_EMPTY " + JSON.stringify({ symbol, lookbackMinutes, responseStatus: response.status, payloadType: Array.isArray(payload) ? "array" : typeof payload, payloadKeys: payload && typeof payload === "object" ? Object.keys(payload).slice(0, 8) : [] }));\n            }\n          }\n          const merged = new Map(existing.map((row) => [Number(row.open_ts_ms), row]));',
  "log empty initial 1m history without flooding logs",
);
method = replaceRegexOnce(
  method,
  /this\.coreScalpCandles\[symbol\]\s*=\s*\[\.\.\.merged\.values\(\)\]\s*\.sort\(\(a,\s*b\)\s*=>\s*a\.open_ts_ms\s*-\s*b\.open_ts_ms\)\s*\.slice\(-240\);\s*updated\s*=\s*true;/,
  "const next = [...merged.values()].sort((a, b) => a.open_ts_ms - b.open_ts_ms).slice(-240);\n          const previousLast = Number(existing[existing.length - 1]?.open_ts_ms || 0);\n          const nextLast = Number(next[next.length - 1]?.open_ts_ms || 0);\n          this.coreScalpCandles[symbol] = next;\n          if (next.length !== existing.length || nextLast !== previousLast) updated = true;",
  "avoid no-op Durable Object storage writes",
);
source = source.slice(0, methodStart) + method + source.slice(methodEnd);

source = replaceOnce(
  source,
  '    if (!isTemporaryMarketAllowed(candidate.symbol)) continue;\n    const isScalpMode =',
  '    if (!isTemporaryMarketAllowed(candidate.symbol)) continue;\n    const venueMaxLeverage = Number(LEVERUP_MARKET_MAX_LEVERAGE[candidate.symbol]);\n    const configuredMinLeverage = Number(env?.LEVERUP_MIN_LEVERAGE || 50);\n    if (Number.isFinite(venueMaxLeverage) && venueMaxLeverage < configuredMinLeverage) {\n      scanDiagnostics.push({ symbol: candidate.symbol, reason: "WATCHLIST_ONLY_MAX_" + venueMaxLeverage + "X_BELOW_" + configuredMinLeverage + "X_ENTRY_FLOOR", venueMaxLeverage, configuredMinLeverage });\n    }\n    const isScalpMode =',
  "do not send below-floor markets to review or execution",
);

source = replaceOnce(
  source,
  'candleLevelSymbols:candleStructureRows.size,coreMarkets:["BTC","ETH","SOL"],trendEntryMarkets:["BTC","ETH","SOL","BNB","HYPE","ZEC","ADA","PUMP"],preferredGroup,',
  'candleLevelSymbols: candleStructureRows.size, oneMinuteCandleCounts: Object.fromEntries(Object.entries(coreScalpCandles || {}).map(([symbol, rows]) => [symbol, Array.isArray(rows) ? rows.length : 0])), fiveMinuteCandleCounts: Object.fromEntries(Object.entries(coreTrendCandles || {}).map(([symbol, rows]) => [symbol, Array.isArray(rows) ? rows.length : 0])), coreMarkets: ["BTC", "ETH", "SOL"], trendEntryMarkets: ["BTC", "ETH", "SOL", "BNB", "HYPE", "ZEC", "ADA", "PUMP"], unsupportedLeverageMarkets: symbols.filter((symbol) => Number.isFinite(Number(LEVERUP_MARKET_MAX_LEVERAGE[symbol])) && Number(LEVERUP_MARKET_MAX_LEVERAGE[symbol]) < Number(env?.LEVERUP_MIN_LEVERAGE || 50)), preferredGroup,',
  "record per-symbol candle coverage and unsupported leverage markets",
);

const runStart = source.indexOf("async function runAdvisorCycle(");
const runMarker = '__name(runAdvisorCycle, "runAdvisorCycle");';
const runEnd = source.indexOf(runMarker, runStart);
if (runStart < 0 || runEnd < 0 || source.includes("reviewCompletedAt: now")) {
  throw new Error("Advisor cycle diagnostics insertion point missing or already patched.");
}
const functionClose = source.lastIndexOf("}", runEnd);
if (functionClose < runStart) throw new Error("Advisor cycle closing brace not found.");
source = source.slice(0, functionClose) +
  '  await env.CIEL_STATE.put("ciel:advisor:last-scan", JSON.stringify({ ...scanSnapshot, scanDiagnostics: scanDiagnostics.slice(-120), reviewCompletedAt: now }), { expirationTtl: 86400 }).catch(() => void 0);\n' +
  source.slice(functionClose);

const oldForecastPoints = "  const points = (Array.isArray(rows) ? rows : []).map((row) => ({\n    ts_ms: Number(row.ts_ms),\n    mid_price: Number(row.mid_price)\n  })).filter((row) => Number.isFinite(row.ts_ms) && row.ts_ms > 0 &&\n    Number.isFinite(row.mid_price) && row.mid_price > 0)\n    .sort((a, b) => a.ts_ms - b.ts_ms).slice(-180);\n  if (points.length < 180) {\n    return unavailable(\"The local forecast requires 180 valid cached one-minute price samples.\", points.length);\n  }";
const newForecastPoints = "  const rawPoints = (Array.isArray(rows) ? rows : []).map((row) => ({\n    ts_ms: Number(row.ts_ms),\n    mid_price: Number(row.mid_price)\n  })).filter((row) => Number.isFinite(row.ts_ms) && row.ts_ms > 0 && Number.isFinite(row.mid_price) && row.mid_price > 0).sort((a, b) => a.ts_ms - b.ts_ms);\n  const minuteBuckets = new Map();\n  for (const point of rawPoints) {\n    const bucket = Math.floor(point.ts_ms / 6e4) * 6e4;\n    const previous = minuteBuckets.get(bucket);\n    if (!previous || point.ts_ms > previous.ts_ms) minuteBuckets.set(bucket, point);\n  }\n  const points = [...minuteBuckets.values()].sort((a, b) => a.ts_ms - b.ts_ms).slice(-180);\n  if (points.length < 61) {\n    return unavailable(\"The local forecast requires at least 61 distinct one-minute price buckets spanning the 60-minute context window.\", points.length);\n  }";
const oldForecastTolerance = "      if (points[i].ts_ms <= target) {\n        return target - points[i].ts_ms <= 90000 ? points[i].mid_price : null;\n      }";
const newForecastTolerance = "      if (points[i].ts_ms <= target) {\n        return target - points[i].ts_ms <= 12e4 ? points[i].mid_price : null;\n      }";
source = replaceOnce(source, oldForecastPoints, newForecastPoints, "bucket high-frequency history into one-minute forecast samples");
source = replaceOnce(source, oldForecastTolerance, newForecastTolerance, "allow one missed one-minute anchor sample");

await writeFile(file, source);
console.log("Applied CIEL incident repair: 1m forecast history, leverage eligibility and post-review diagnostics.");
