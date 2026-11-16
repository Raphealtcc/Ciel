import { readFile, writeFile } from "node:fs/promises";

const file = "reconstructed/patched-worker.js";
let source = await readFile(file, "utf8");

function once(before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(label + ": expected exactly one match, found " + count);
  source = source.replace(before, after);
}

if (!source.includes("analyzeLimitReach")) {
  source = 'import { analyzeLimitReach } from "../src/limit-reach.js";\n' + source;
}

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
