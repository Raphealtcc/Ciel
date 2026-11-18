import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { analyzeLimitReach } from "../src/limit-reach.js";

const now = 1_800_000_000_000;

function fixture(side = "SHORT") {
  const rows = [];
  const highs = new Set([30, 80, 130, 180, 230]);
  const lows = new Set([55, 105, 155, 205, 255]);
  for (let i = 0; i < 288; i++) {
    let open = 100, high = 100.12, low = 99.88, close = 100;
    if (highs.has(i)) { open = 100.4; high = 101; low = 100.3; close = 100.5; }
    if (lows.has(i)) { open = 99.6; high = 99.7; low = 99; close = 99.5; }
    rows.push({
      open_ts_ms: now - (288 - i) * 300_000,
      close_ts_ms: now - (287 - i) * 300_000 - 30_000,
      open_price: open, high_price: high, low_price: low, close_price: close, volume: 100,
    });
  }
  const last = rows[rows.length - 1];
  if (side === "SHORT") Object.assign(last, { open_price: 100.95, high_price: 101.15, low_price: 100.6, close_price: 100.75 });
  else Object.assign(last, { open_price: 99.05, high_price: 99.4, low_price: 98.85, close_price: 99.25 });
  return rows;
}

const short = analyzeLimitReach("BTC", fixture("SHORT"), now);
assert.ok(short, "repeated high/low levels plus a rejection should produce a short candidate");
assert.equal(short.side, "SHORT");
assert.equal(short.strategy, "LIMIT_REACH_RANGE_REVERSAL");
assert.equal(short.regime, "COUNTER_TREND_REVERSAL");
assert.ok(short.repeatedTouches.high >= 2 && short.repeatedTouches.low >= 2);
assert.ok(short.targetPct > short.stopPct * 1.35);
assert.ok(short.scoreComponents.includes("LIMIT_REACH_OPPOSITE_ZONE_TARGET"));

const long = analyzeLimitReach("ETH", fixture("LONG"), now);
assert.ok(long, "a repeated low rejection should produce a long candidate");
assert.equal(long.side, "LONG");
assert.equal(long.strategy, "LIMIT_REACH_RANGE_REVERSAL");

const oneTouch = fixture("SHORT");
for (const i of [80, 130, 180, 230]) Object.assign(oneTouch[i], { open_price: 100, high_price: 100.12, low_price: 99.88, close_price: 100 });
assert.equal(analyzeLimitReach("BTC", oneTouch, now), null, "one high touch is not enough to establish a repeated resistance zone");

const stale = fixture("SHORT").map((row) => ({ ...row, close_ts_ms: row.close_ts_ms - 20 * 60_000 }));
assert.equal(analyzeLimitReach("BTC", stale, now), null, "stale 5m candles must not generate a candidate");

const source = await readFile("reconstructed/patched-worker.js", "utf8");
assert.ok(source.includes('import { analyzeLimitReach } from "../src/limit-reach.js"'));
assert.ok(source.includes("const limitReach = analyzeLimitReach(sym,candles.five,now)"));
assert.ok(source.includes('strategy:"LIMIT_REACH_RANGE_REVERSAL"'));
assert.ok(source.includes("LIMIT_REACH_RANGE_REVERSAL") && source.includes("adaptiveStrategyPriority"));
assert.ok(source.includes(".slice(-300)"), "the strategy must receive the full 25h Durable Object candle cache");
assert.ok(source.includes('this.coreScalpCandles = values[23] || {};'), "core scalp cache must restore from state slot 23");
assert.ok(source.includes('this.coreTrendCandles = values[24] || {};'), "core trend cache must restore from state slot 24");
assert.ok(source.includes('this.historyBootstrapDone = values[27] === true;'), "bootstrap completion must restore from state slot 27");
assert.ok(source.includes('this.lastHistoryBootstrapAt = Number(values[28]) || 0;'), "bootstrap cooldown timestamp must restore from state slot 28");
const strategySource = await readFile("src/limit-reach.js", "utf8");
assert.ok(!strategySource.includes("env.DB") && !strategySource.includes("fetch("), "Limit Reach must use only the existing cached candle buffer");

const quality = await readFile("src/signal-quality.js", "utf8");
assert.ok(quality.includes('"LIMIT_REACH_RANGE_REVERSAL"'));
assert.ok(quality.includes('strategy.includes("LIMIT_REACH")'));

assert.ok(source.includes("if (!horizonMigrationJustRan && now - lastRun < 60 * 60e3) return cached;"));
assert.ok(source.includes("LIMIT 20"), "non-critical shadow outcome work must use a smaller batch");

console.log("PASS: Limit Reach repeated-level detection, rejection confirmation, opposite-zone targets, independent candidate wiring and bounded resource usage.");
