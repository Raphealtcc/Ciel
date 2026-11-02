import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const input = path.join(root, "reconstructed", "worker.js");
const output = path.join(root, "reconstructed", "patched-worker.js");
let source = await readFile(input, "utf8");

replaceExactlyOnce(
  "BTC: 1001, ETH: 1001, MON: 25, BNB: 50, XRP: 100,",
  "BTC: 100, ETH: 100, MON: 25, BNB: 50, XRP: 100,",
  "correct BTC/ETH max leverage from 1001 to verified 100",
);

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
  'if (!paperStorage || paperCash + 1e-9 < PAPER_MARGIN_MON) {\n    console.log("Ciel has no free 22 MON paper margin; no new recommendation will be issued until a paper slot is free.");\n    return;\n  }',
  'if (!paperStorage) console.log("Ciel paper storage unavailable; advisor recommendations will continue without automatic paper entries.");',
  "keep advisor recommendations running when paper storage or margin is unavailable",
);

replaceExactlyOnce(
  'if (sym === "MON" || Number(LEVERUP_MARKET_MAX_LEVERAGE[sym]) !== 50 || openPaperSymbols.has(sym)) continue;',
  'const marketMaxLeverage = Number(LEVERUP_MARKET_MAX_LEVERAGE[sym]);\n    const requiredPaperMargin = minimumMarginForMarketLeverage(marketMaxLeverage);\n    if (sym === "MON" || requiredPaperMargin === null || openPaperSymbols.has(sym)) continue;',
  "scan markets using their eligible leverage/margin tier",
);

replaceExactlyOnce(
  'const collateral = PAPER_MARGIN_MON, leverage = PAPER_LEVERAGE;',
  'const marketMaxLeverage = Number(LEVERUP_MARKET_MAX_LEVERAGE[candidate.symbol]);\n    const collateral = minimumMarginForMarketLeverage(marketMaxLeverage);\n    const leverage = marketMaxLeverage >= 100 ? 100 : PAPER_LEVERAGE;',
  "store the same tier-specific margin and leverage in the advisor proposal",
);

replaceExactlyOnce(
  '"50x notional estimate at 100% collateral ratio ≈ " + money(notional) + "."',
  'String(p.leverage) + "x notional estimate at 100% collateral ratio ≈ " + money(notional) + "."',
  "show the correct leverage in the setup card",
);

replaceExactlyOnce(
  '"Proposal expires in 15 minutes. One new setup is evaluated per five-minute cycle; paper entries pause when less than 22 MON margin is free."',
  '"Proposal expires in 15 minutes. One new setup is evaluated per five-minute cycle; paper entries pause when free balance is below the eligible market\'s minimum margin."',
  "show the tier-aware paper cash requirement in the setup card",
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

replaceExactlyOnce(
  '"/profits \\u2014 automatic 50x paper-trading balance and P&L"',
  '"/profits \\u2014 automatic leverage-tiered paper-trading balance and P&L"',
  "update help command for leverage-tiered paper trading",
);

replaceExactlyOnce(
  '"Reference price: $" + fmt(p.entry_price),',
  '"Reference price: $" + fmt(p.entry_price),\n    "Reference price source: Hyperliquid mid; LeverUp settles against Pyth and applies per-pair pool slippage. Check LeverUp\'s live quote before entry.",',
  "disclose Hyperliquid reference versus LeverUp execution price",
);

replaceExactlyOnce(
  '"Market quality: 24h notional $" + fmt(market.volume)',
  '"Hyperliquid market quality: 24h notional $" + fmt(market.volume)',
  "label market-quality inputs as Hyperliquid data",
);

replaceExactlyOnce(
  '"AI evidence basis: CIEL technical signal, local forecast and live derivatives/order-book metrics only. External news and fundamentals were not checked."',
  '"AI evidence basis: CIEL technical signal, local forecast and Hyperliquid derivatives/order-book metrics only. External news and fundamentals were not checked."',
  "label AI evidence inputs as Hyperliquid data",
);

replaceExactlyOnce(
  '"Gross mark-based paper result; fees, funding, slippage and liquidation mechanics are excluded."',
  '"Gross Hyperliquid-mid paper result; LeverUp Pyth/pool fills, fees, funding/holding fees, oracle costs, slippage, collateral CR, minimum-hold restrictions and liquidation are excluded."',
  "make paper close notification explicit about LeverUp execution gaps",
);

replaceExactlyOnce(
  '"Gross simulated results using Hyperliquid mids, not LeverUp fills. Fees, funding, slippage, collateral haircuts and liquidation mechanics are not simulated."',
  '"Paper results use Hyperliquid mids, not LeverUp Pyth/pool fills. Fees, funding/holding fees, oracle costs, slippage, collateral CR, minimum-hold restrictions and liquidation are not simulated."',
  "make profits help text explicit about LeverUp execution gaps",
);

await writeFile(output, source);
console.log(`Wrote patched staging candidate: ${output}`);
console.log("Recovered source fragments and exact-bundle reconstruction remain unchanged.");
