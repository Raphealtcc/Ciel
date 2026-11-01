import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const input = path.join(root, "reconstructed", "worker.js");
const output = path.join(root, "reconstructed", "patched-worker.js");
let source = await readFile(input, "utf8");

function replaceExactlyOnce(before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected exactly one match, found ${count}. Refusing to patch.`);
  }
  source = source.replace(before, after);
  console.log(`Applied paper-simulation patch: ${label}`);
}

replaceExactlyOnce(
  'if (maxLeverage !== 50) return { opened: false, reason: "LeverUp market is not a 50x market." };',
  'if (minimumMarginForMarketLeverage(maxLeverage) === null) return { opened: false, reason: "LeverUp market leverage tier is unsupported." };',
  "allow supported 100x+ market tiers in paper entry",
);

replaceExactlyOnce(
  'reason: "Paper balance has less than the 22 MON minimum margin available."',
  'reason: "Paper balance has less than the required " + margin + " MON minimum margin available."',
  "report the actual tier-specific paper margin",
);

replaceExactlyOnce(
  'maxMarketLeverage: maxLeverage, leverage: PAPER_LEVERAGE, marginMon: margin,',
  'maxMarketLeverage: maxLeverage, leverage: maxLeverage >= 100 ? 100 : PAPER_LEVERAGE, marginMon: margin,',
  "simulate >=100x markets at a conservative 100x baseline",
);

replaceExactlyOnce(
  'if (!paperStorage || paperCash + 1e-9 < PAPER_MARGIN_MON) {',
  'if (!paperStorage || paperCash + 1e-9 < 11) {',
  "permit paper scanner when the 11 MON tier is affordable",
);

replaceExactlyOnce(
  'if (sym === "MON" || Number(LEVERUP_MARKET_MAX_LEVERAGE[sym]) !== 50 || openPaperSymbols.has(sym)) continue;',
  'const marketMaxLeverage = Number(LEVERUP_MARKET_MAX_LEVERAGE[sym]);\n    const requiredPaperMargin = minimumMarginForMarketLeverage(marketMaxLeverage);\n    if (sym === "MON" || requiredPaperMargin === null || paperCash + 1e-9 < requiredPaperMargin || openPaperSymbols.has(sym)) continue;',
  "scan markets using their eligible leverage/margin tier",
);

replaceExactlyOnce(
  '? "\\n\\n🧪 PAPER TRADE AUTO-OPENED — " + candidate.side + " " + candidate.symbol + "\\nMargin: 22 MON | leverage: 50x | estimated notional: $" + (22 * prices.MON * PAPER_LEVERAGE).toFixed(2) + "\\nPaper balance remaining: " + Number(paperResult.availableBalanceMon).toFixed(3) + " MON. Use /profits for live and realised P&L."',
  '? "\\n\\n🧪 PAPER TRADE AUTO-OPENED — " + candidate.side + " " + candidate.symbol + "\\nMargin: " + paperResult.trade.marginMon + " MON | leverage: " + paperResult.trade.leverage + "x | estimated notional: $" + (paperResult.trade.marginMon * prices.MON * paperResult.trade.leverage).toFixed(2) + "\\nPaper balance remaining: " + Number(paperResult.availableBalanceMon).toFixed(3) + " MON. Use /profits for live and realised P&L."',
  "show actual margin and leverage in paper entry alert",
);

replaceExactlyOnce(
  '"🧪 CIEL PAPER TRADING — AUTOMATIC / 50x ONLY"',
  '"🧪 CIEL PAPER TRADING — AUTOMATIC / LEVERAGE-TIERED"',
  "label paper summary as leverage-tiered",
);

await writeFile(output, source);
console.log(`Wrote patched staging candidate: ${output}`);
console.log("Recovered source fragments and exact-bundle reconstruction remain unchanged.");
