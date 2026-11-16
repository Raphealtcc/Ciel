import { readFile, writeFile } from "node:fs/promises";

const file = "reconstructed/patched-worker.js";
let source = await readFile(file, "utf8");

function once(before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(label + ": expected exactly one match, found " + count);
  source = source.replace(before, after);
}

if (!source.includes('import { analyzeLimitReach } from "../src/limit-reach.js"')) {
  source = 'import { analyzeLimitReach } from "../src/limit-reach.js";\n' + source;
}
once(
  'this.coreScalpCandles = values[22] || {};',
  'this.coreScalpCandles = values[23] || {};',
  "restore core scalp candles from the correct Durable Object state slot"
);

once(
  'this.coreTrendCandles = values[23] || {};',
  'this.coreTrendCandles = values[24] || {};',
  "restore core trend candles from the correct Durable Object state slot"
);

once(
  'this.xyzQntMid = values[24] || null;',
  'this.xyzQntMid = values[25] || null;',
  "restore QNT mid price from the correct Durable Object state slot"
);

once(
  'this.lastXyzQntRefreshAt = Number(values[25]) || 0;',
  'this.lastXyzQntRefreshAt = Number(values[26]) || 0;',
  "restore QNT refresh time from the correct Durable Object state slot"
);

once(
  'this.historyBootstrapDone = values[26] === true;',
  'this.historyBootstrapDone = values[27] === true;',
  "restore history bootstrap completion flag from the correct Durable Object state slot"
);

once(
  'this.lastHistoryBootstrapAt = Number(values[27]) || 0;',
  'this.lastHistoryBootstrapAt = Number(values[28]) || 0;',
  "restore history bootstrap timestamp from the correct Durable Object state slot"
);


once(
  'const five = Array.isArray(coreTrendCandles?.[symbol]) ? coreTrendCandles[symbol].filter((row) => Number(row.close_ts_ms) <= now).slice(-60) : [];',
  'const five = Array.isArray(coreTrendCandles?.[symbol]) ? coreTrendCandles[symbol].filter((row) => Number(row.close_ts_ms) <= now).slice(-288) : [];',
  "pass the existing 24h cached 5m window to strategy candidates"
);

once(
  'if (strategy === "MULTI_MARKET_LEVEL_SWEEP_RECLAIM") return -0.06;',
  'if (strategy === "LIMIT_REACH_RANGE_REVERSAL") return 0.07;\n  if (strategy === "MULTI_MARKET_LEVEL_SWEEP_RECLAIM") return -0.06;',
  "include Limit Reach in adaptive strategy ranking without restricting other strategies"
);

await writeFile(file, source);
console.log("Limit Reach candidate integration applied: cached 5m data only, independent of other strategy candidates.");
