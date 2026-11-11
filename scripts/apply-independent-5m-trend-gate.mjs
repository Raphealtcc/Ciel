import { readFile, writeFile } from "node:fs/promises";

const file = "reconstructed/patched-worker.js";
let source = await readFile(file, "utf8");

const oldBlock = `if (!candles || candles.one.length < 25 || candles.five.length < 40) {
        scanDiagnostics.push({symbol:sym,strategy:"CORE_PULLBACK_SCALP",reason:"INSUFFICIENT_CLOSED_CANDLE_HISTORY"});
        scanDiagnostics.push({symbol:sym,strategy:"CORE_TREND_CONTINUATION",reason:"INSUFFICIENT_CLOSED_5M_HISTORY"});
      } else {
        const scalp = analyzeCorePullbackScalp(sym,candles.one,candles.five,now);
        if (scalp) candidates.push(scalp);
        else scanDiagnostics.push({symbol:sym,strategy:"CORE_PULLBACK_SCALP",reason:"PULLBACK_RECLAIM_VOLUME_OR_FRESHNESS_GATE"});
        const continuation = analyzeCoreTrendContinuation(sym,candles.five,now);
        if (continuation) candidates.push(continuation);
        else scanDiagnostics.push({symbol:sym,strategy:"CORE_TREND_CONTINUATION",reason:"EMA_BREAKOUT_RETEST_VOLUME_OR_FRESHNESS_GATE"});
      }`;
const newBlock = `if (!candles || candles.one.length < 25 || candles.five.length < 40) {
        scanDiagnostics.push({symbol:sym,strategy:"CORE_PULLBACK_SCALP",reason:"INSUFFICIENT_CLOSED_CANDLE_HISTORY"});
      } else {
        const scalp = analyzeCorePullbackScalp(sym,candles.one,candles.five,now);
        if (scalp) candidates.push(scalp);
        else scanDiagnostics.push({symbol:sym,strategy:"CORE_PULLBACK_SCALP",reason:"PULLBACK_RECLAIM_VOLUME_OR_FRESHNESS_GATE"});
      }
      if (!candles || candles.five.length < 40) {
        scanDiagnostics.push({symbol:sym,strategy:"CORE_TREND_CONTINUATION",reason:"INSUFFICIENT_CLOSED_5M_HISTORY"});
      } else {
        const continuation = analyzeCoreTrendContinuation(sym,candles.five,now);
        if (continuation) candidates.push(continuation);
        else scanDiagnostics.push({symbol:sym,strategy:"CORE_TREND_CONTINUATION",reason:"EMA_BREAKOUT_RETEST_VOLUME_OR_FRESHNESS_GATE"});
      }`;
const count = source.split(oldBlock).length - 1;
if (count !== 1) throw new Error("Independent 5m trend gate patch expected one combined gate, found " + count);
source = source.replace(oldBlock, newBlock);
await writeFile(file, source);
console.log("Separated 1m pullback and 5m trend-continuation history gates.");
