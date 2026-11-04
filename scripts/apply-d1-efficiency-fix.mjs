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
  '    const symbols = ["BTC", "ETH", "SOL"].filter((symbol) => Number(this.latest[symbol]) > 0);',
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
  '  async updateAlertOutcomes(now) {\n    const lastUpdate = Number(await this.state.storage.get("lastAlertOutcomeUpdateAt") || 0);\n    if (lastUpdate && now - lastUpdate < 5 * 60 * 1e3) return;\n    const result = await this.env.DB.prepare(',
  "throttle non-critical alert outcome analytics to one D1 read batch every five minutes",
);
once(
  'ORDER BY created_at_ms ASC LIMIT 200',
  'ORDER BY created_at_ms ASC LIMIT 30',
  "bound each alert outcome batch to 30 rows",
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
  'req: { coin: symbol, interval: "5m", startTime: (["BTC","ETH","SOL"].includes(symbol) && (this.coreTrendCandles[symbol] || []).length < 40) ? now - 5 * 60 * 60 * 1e3 : startTime, endTime }',
  "bootstrap 5h of 5m candles only when the core cache is cold");
onceInMethod('          if (!latestClosed) return;',
  '          if (!latestClosed) return;\n          if (["BTC","ETH","SOL"].includes(symbol)) {\n            const merged = new Map((Array.isArray(this.coreTrendCandles[symbol]) ? this.coreTrendCandles[symbol] : []).map((row) => [Number(row.open_ts_ms), row]));\n            for (const candle of valid) {\n              if (candle.closeAt > now) continue;\n              merged.set(candle.openAt, { open_ts_ms: candle.openAt, close_ts_ms: candle.closeAt, open_price: candle.open, high_price: candle.high, low_price: candle.low, close_price: candle.close, volume: candle.volume });\n            }\n            this.coreTrendCandles[symbol] = [...merged.values()].sort((left, right) => left.open_ts_ms - right.open_ts_ms).slice(-60);\n            coreTrendUpdated = true;\n          }',
  "merge fresh closed 5m candles into the persistent DO cache");
onceInMethod('    }\n  }\n', '    }\n    if (coreTrendUpdated) await this.state.storage.put("coreTrendCandles", this.coreTrendCandles).catch((error) => console.error("Core trend candle state persistence failed: " + String(error).slice(0,160)));\n  }\n', "persist the 5m cache once per snapshot batch");
source = source.slice(0, trendCandleMethodStart) + trendCandleMethod + source.slice(trendCandleMethodEnd);

await writeFile(file, source);
console.log("D1 efficiency patch complete: the core scalp still receives fresh closed 1m candles every minute; its candle cache is Durable Object-persistent, and D1 retains 5m history and all other market history.");
