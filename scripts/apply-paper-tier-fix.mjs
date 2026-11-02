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
  'const perpSymbols = universe.map((asset) => String(asset?.name || "").trim().toUpperCase()).filter((symbol) => watch.has(symbol) && Number(this.latest[symbol]) > 0);\n      const missingBooks = perpSymbols.filter((symbol) => now - (this.bookLastWrite[symbol] || 0) > 15e4);',
  'const perpAssets = universe.map((asset) => ({ symbol: String(asset?.name || "").trim().toUpperCase(), coin: String(asset?.name || "").trim() })).filter(({ symbol }) => watch.has(symbol) && Number(this.latest[symbol]) > 0);\n      const missingBooks = perpAssets.filter(({ symbol }) => now - (this.bookLastWrite[symbol] || 0) > 15e4);',
  "preserve original Hyperliquid coin casing for order-book fallback",
);

replaceExactlyOnce(
  'missingBooks.slice(offset, offset + 4).map(async (symbol) => {',
  'missingBooks.slice(offset, offset + 4).map(async ({ symbol, coin }) => {',
  "keep canonical CIEL symbol separate from upstream Hyperliquid coin name",
);

replaceExactlyOnce(
  'JSON.stringify({ type: "l2Book", coin: symbol })',
  'JSON.stringify({ type: "l2Book", coin })',
  "request REST order books with the original Hyperliquid coin name",
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


replaceExactlyOnce(
  "var PAPER_STARTING_BALANCE_MON = 60;",
  "var PAPER_STARTING_BALANCE_MON = 100;",
  "set fresh paper account budget to the requested 100 MON",
);
replaceExactlyOnce(
  "function minimumMarginForMarketLeverage(leverage) {\n  if (Number(leverage) === 50) return 22;\n  if (Number(leverage) >= 100) return 11;\n  return null;\n}",
  "function minimumMarginForMarketLeverage(leverage) {\n  if (Number(leverage) === 50) return 22;\n  if (Number(leverage) >= 100) return 11;\n  return null;\n}\nfunction paperMarginLimits(minMarginMon, availableBalanceMon, startingBalanceMon, leverage, stopPct, openRiskMon = 0) {\n  const minimum = Number(minMarginMon), available = Number(availableBalanceMon), starting = Number(startingBalanceMon);\n  const lev = Number(leverage), stop = Number(stopPct);\n  const tradeRiskBudgetMon = starting * 0.05;\n  const portfolioRiskBudgetMon = starting * 0.10;\n  const remainingPortfolioRiskMon = Math.max(0, portfolioRiskBudgetMon - Math.max(0, Number(openRiskMon) || 0));\n  const riskBudgetMon = Math.min(tradeRiskBudgetMon, remainingPortfolioRiskMon);\n  const riskPerMargin = lev * stop / 100;\n  const maxByRisk = riskPerMargin > 0 ? riskBudgetMon / riskPerMargin : 0;\n  const maxMarginMon = Math.floor(Math.min(available, maxByRisk) * 1000) / 1000;\n  return { minMarginMon: minimum, maxMarginMon, availableBalanceMon: available, startingBalanceMon: starting, leverage: lev, stopPct: stop, tradeRiskBudgetMon, portfolioRiskBudgetMon, remainingPortfolioRiskMon, riskBudgetMon, openRiskMon: Math.max(0, Number(openRiskMon) || 0), feasible: Number.isFinite(minimum) && minimum > 0 && Number.isFinite(available) && available + 1e-9 >= minimum && maxMarginMon + 1e-9 >= minimum };\n}\nfunction choosePaperMargin(aiMarginMon, limits) {\n  if (!limits?.feasible) return null;\n  const proposed = Number(aiMarginMon);\n  const selected = Number.isFinite(proposed) ? Math.max(limits.minMarginMon, Math.min(limits.maxMarginMon, proposed)) : limits.minMarginMon;\n  return Math.round(selected * 1000) / 1000;\n}",
  "add AI-bounded margin sizing with 5% per-trade and 10% portfolio stop-risk caps",
);
replaceExactlyOnce(
  'if (minimumMarginForMarketLeverage(maxLeverage) === null) return { opened: false, reason: "LeverUp market leverage tier is unsupported." };',
  'if (minimumMarginForMarketLeverage(maxLeverage) === null) return { opened: false, reason: "LeverUp market leverage tier is unsupported." };\n  const selectedLeverage = Number(params.leverage) || (maxLeverage >= 100 ? 100 : PAPER_LEVERAGE);\n  if (!(selectedLeverage > 0 && selectedLeverage <= maxLeverage)) return { opened: false, reason: "Requested paper leverage exceeds the verified market maximum." };',
  "enforce the verified selected leverage in paper execution",
);
replaceExactlyOnce(
  "const margin = minimumMarginForMarketLeverage(maxLeverage);\n    const available = Number(state.availableBalanceMon ?? PAPER_STARTING_BALANCE_MON);",
  "const minimumMargin = minimumMarginForMarketLeverage(maxLeverage);\n    const requestedMargin = Number(params.marginMon);\n    const margin = Number.isFinite(requestedMargin) ? Math.round(requestedMargin * 1000) / 1000 : minimumMargin;\n    const available = Number(state.availableBalanceMon ?? PAPER_STARTING_BALANCE_MON);\n    if (!Number.isFinite(margin) || margin + 1e-9 < minimumMargin) {\n      result = { opened: false, reason: \"Selected paper margin is below the LeverUp market minimum of \" + minimumMargin + \" MON.\", availableBalanceMon: Number.isFinite(available) ? available : 0 };\n      return;\n    }",
  "use the AI-selected margin while enforcing the market minimum and available balance",
);
replaceExactlyOnce(
  "maxMarketLeverage: maxLeverage, leverage: maxLeverage >= 100 ? 100 : PAPER_LEVERAGE, marginMon: margin,",
  "maxMarketLeverage: maxLeverage, leverage: selectedLeverage, marginMon: margin,",
  "persist the verified selected leverage and AI-sized margin",
);
replaceExactlyOnce(
  'async function review(env, s, forecast, market, intraday, eventIntel = null) {',
  'async function review(env, s, forecast, market, intraday, eventIntel = null, sizing = null) {',
  "pass hard sizing constraints into the Gemini reviewer",
);
replaceExactlyOnce(
  '"Return JSON only: verdict APPROVE, REJECT or WAIT; reason under 240 characters; flags array.",',
  '"Choose paperMarginMon between sizing.minMarginMon and sizing.maxMarginMon. Keep it at or near the minimum for partial confirmation, forecast uncertainty, mixed evidence or weak market quality. Increase it only when independent evidence agrees, the forecast envelope supports the direction, the Gemini verdict is APPROVE, and market quality is healthy. Never exceed the supplied maximum. This is margin sizing, not a win-probability estimate.",\n    "Return JSON only: verdict APPROVE, REJECT or WAIT; reason under 240 characters; flags array; paperMarginMon number.",\n    "Paper sizing constraints in MON: " + JSON.stringify(sizing),',
  "ask Gemini to choose margin within the deterministic venue and risk limits",
);
replaceExactlyOnce(
  '"Assumptions: 22 MON minimum collateral and 50x requested leverage. MON collateral CR varies; all P&L estimates assume 100% CR and are upper bounds. Ciel never executes orders."',
  '"The leverage and market minimum are supplied in the sizing constraints; do not change them. Current user-observed order-panel floors are 11 MON for 100x and 22 MON for 50x; these are conservative operating floors, not a live on-chain collateral-ratio quote. MON collateral CR can change. P&L estimates assume 100% CR and are upper bounds. Ciel never executes orders."',
  "remove the old fixed 22 MON/50x assumption from Gemini context",
);
replaceExactlyOnce(
  'responseSchema: { type: "OBJECT", properties: { verdict: { type: "STRING", enum: ["APPROVE", "REJECT", "WAIT"] }, reason: { type: "STRING" }, flags: { type: "ARRAY", items: { type: "STRING" } } }, required: ["verdict", "reason", "flags"] }',
  'responseSchema: { type: "OBJECT", properties: { verdict: { type: "STRING", enum: ["APPROVE", "REJECT", "WAIT"] }, reason: { type: "STRING" }, flags: { type: "ARRAY", items: { type: "STRING" } }, paperMarginMon: { type: "NUMBER" } }, required: ["verdict", "reason", "flags", "paperMarginMon"] }',
  "require a structured AI margin recommendation",
);
replaceExactlyOnce(
  'const out = { verdict, reason: typeof v.reason === "string" ? v.reason.slice(0, 240) : "No usable Gemini reason.", flags:',
  'const out = { verdict, paperMarginMon: Number.isFinite(Number(v.paperMarginMon)) ? Number(v.paperMarginMon) : null, reason: typeof v.reason === "string" ? v.reason.slice(0, 240) : "No usable Gemini reason.", flags:',
  "retain the model-selected margin in the review result",
);
replaceExactlyOnce(
  'const paperCash = Number(paperState?.availableBalanceMon ?? PAPER_STARTING_BALANCE_MON);',
  'const paperCash = Number(paperState?.availableBalanceMon ?? PAPER_STARTING_BALANCE_MON);\n  const paperStartingBalance = Number(paperState?.startingBalanceMon ?? PAPER_STARTING_BALANCE_MON);\n  const openPaperRiskMon = (paperState?.trades || []).filter((trade) => trade.status === "OPEN").reduce((sum, trade) => { const margin = Number(trade.marginMon) || 0, lev = Number(trade.leverage) || 0, stop = Number(trade.stopPct) || 0; return sum + (margin > 0 && lev > 0 && stop > 0 ? margin * lev * stop / 100 : margin); }, 0);',
  "calculate the 100 MON budget and remaining portfolio stop-risk",
);
replaceExactlyOnce(
  'if (sym === "MON" || requiredPaperMargin === null || openPaperSymbols.has(sym)) continue;',
  'if (sym === "MON" || requiredPaperMargin === null || paperCash + 1e-9 < requiredPaperMargin || openPaperSymbols.has(sym)) continue;',
  "only scan paper candidates whose venue minimum fits the remaining budget",
);
replaceExactlyOnce(
  '    const reviewed = candidate.mode === "RANGE_SCALP"\n      ? { verdict: "WAIT", reason: "Range scalp passed deterministic regime, CCI/rejection, statistical forecast and market-quality gates; Gemini review intentionally skipped to conserve daily API quota.", flags: ["LOCAL_RANGE_SCALP_REVIEW"], model: "CIEL deterministic range guard", queries: [], sources: [] }\n      : await review(env,candidate,forecast,reviewerMarket,intraday,eventIntel);',
  '    const marketMaxLeverage = Number(LEVERUP_MARKET_MAX_LEVERAGE[candidate.symbol]);\n    const leverage = marketMaxLeverage >= 100 ? 100 : PAPER_LEVERAGE;\n    const minimumMargin = minimumMarginForMarketLeverage(marketMaxLeverage);\n    const sizingLimits = paperMarginLimits(minimumMargin, paperCash, paperStartingBalance, leverage, candidate.stopPct, openPaperRiskMon);\n    if (!sizingLimits.feasible) { console.log("Ciel skipped " + candidate.symbol + ": minimum margin or stop-risk exceeds the remaining 100 MON paper budget."); continue; }\n    const reviewed = candidate.mode === "RANGE_SCALP"\n      ? { verdict: "WAIT", reason: "Range scalp passed deterministic regime, CCI/rejection, statistical forecast and market-quality gates; Gemini review intentionally skipped to conserve daily API quota.", flags: ["LOCAL_RANGE_SCALP_REVIEW"], model: "CIEL deterministic range guard", queries: [], sources: [], paperMarginMon: null }\n      : await review(env,candidate,forecast,reviewerMarket,intraday,eventIntel,sizingLimits);',
  "calculate the candidate-specific size ceiling before asking Gemini",
);
replaceExactlyOnce(
  'const collateral = minimumMarginForMarketLeverage(marketMaxLeverage);\n    const leverage = marketMaxLeverage >= 100 ? 100 : PAPER_LEVERAGE;',
  'const collateral = choosePaperMargin(reviewed.verdict === "APPROVE" ? reviewed.paperMarginMon : null, sizingLimits);\n    const marginSizingSource = reviewed.verdict === "APPROVE" && Number.isFinite(Number(reviewed.paperMarginMon)) ? "GEMINI_AI" : "MINIMUM_FALLBACK";\n    if (!Number.isFinite(collateral) || collateral + 1e-9 < sizingLimits.minMarginMon || collateral > sizingLimits.maxMarginMon + 1e-9) { console.log("Ciel skipped " + candidate.symbol + ": AI margin could not be safely clamped."); continue; }',
  "use Gemini's margin selection only after deterministic clamping",
);
replaceExactlyOnce(
  'const rationale = candidate.reason + " " + forecastSummary + " " + reviewSummary + timingSummary + " Strategy " + candidate.mode + "; technical strength model v3: " + (candidate.confidence * 100).toFixed(0) + "/100 across " + (candidate.scoreComponents || []).join("+") + "; not a win probability." + (technicalOnly ? " Technical-only fallback; confirmation incomplete." : "");',
  'const rationale = candidate.reason + " " + forecastSummary + " " + reviewSummary + timingSummary + " Margin sizing: " + marginSizingSource + " selected " + collateral.toFixed(3) + " MON inside a " + sizingLimits.minMarginMon + "–" + sizingLimits.maxMarginMon + " MON range; per-trade stop-risk cap " + sizingLimits.tradeRiskBudgetMon.toFixed(2) + " MON, portfolio cap " + sizingLimits.portfolioRiskBudgetMon.toFixed(2) + " MON. Strategy " + candidate.mode + "; technical strength model v3: " + (candidate.confidence * 100).toFixed(0) + "/100 across " + (candidate.scoreComponents || []).join("+") + "; not a win probability." + (technicalOnly ? " Technical-only fallback; confirmation incomplete." : "");',
  "record the chosen margin and risk guard in the proposal rationale",
);
replaceExactlyOnce(
  'const position = { id, symbol: candidate.symbol, side: candidate.side, entry_price: candidate.entry, actual_entry_price: null, tracking_entry_price: null, tracking_started_at_ms: null, stop_price: stop, target_price: target, stop_pct: candidate.stopPct, target_pct: candidate.targetPct, confidence: candidate.confidence, strategy: candidate.strategy, rationale, status: "PROPOSED", created_at_ms: now, expires_at_ms: expires, mon_collateral: collateral, leverage, entry_mon_usd: prices.MON, manual_entry_at_ms: null };',
  'const position = { id, symbol: candidate.symbol, side: candidate.side, entry_price: candidate.entry, actual_entry_price: null, tracking_entry_price: null, stop_price: stop, target_price: target, stop_pct: candidate.stopPct, target_pct: candidate.targetPct, confidence: candidate.confidence, strategy: candidate.strategy, rationale, status: "PROPOSED", created_at_ms: now, expires_at_ms: expires, mon_collateral: collateral, leverage, margin_sizing_source: marginSizingSource, entry_mon_usd: prices.MON, manual_entry_at_ms: null };',
  "preserve AI sizing source in the setup notification object",
);
replaceExactlyOnce(
  'paperResult = await openPaperTrade(paperStorage, { signalId:id, symbol:candidate.symbol, side:candidate.side, entryPrice:candidate.entry, stopPrice:stop, targetPrice:target, stopPct:candidate.stopPct, targetPct:candidate.targetPct, confidence:candidate.confidence, strategy:candidate.strategy, entryMonUsd:prices.MON, holdMinutes:candidate.holdMinutes || (candidate.mode === "RANGE_SCALP" ? 12 : 180), mode:candidate.mode, regime:candidate.regime, now });',
  'paperResult = await openPaperTrade(paperStorage, { signalId:id, symbol:candidate.symbol, side:candidate.side, entryPrice:candidate.entry, stopPrice:stop, targetPrice:target, stopPct:candidate.stopPct, targetPct:candidate.targetPct, confidence:candidate.confidence, strategy:candidate.strategy, entryMonUsd:prices.MON, marginMon:collateral, leverage, holdMinutes:candidate.holdMinutes || (candidate.mode === "RANGE_SCALP" ? 12 : 180), mode:candidate.mode, regime:candidate.regime, now });',
  "open the paper trade with the exact AI-sized margin shown in the proposal",
);
replaceExactlyOnce(
  '"Illustrative paper margin: " + p.mon_collateral.toFixed(0) + " MON at live MON $"',
  '"AI-sized paper margin (" + (p.margin_sizing_source || "MINIMUM_FALLBACK") + "): " + p.mon_collateral.toFixed(3) + " MON at live MON $"',
  "show the AI-selected or minimum-fallback margin on the setup card",
);

await writeFile(output, source);
console.log(`Wrote patched staging candidate: ${output}`);
console.log("Recovered source fragments and exact-bundle reconstruction remain unchanged.");
