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
  'const missingBooks = perpAssets.filter(({ symbol }) => now - (this.bookLastWrite[symbol] || 0) > 15e4);',
  'const missingBooks = perpAssets.filter(({ symbol }) => now - (this.bookLastWrite[symbol] || 0) > 9e4);',
  "refresh REST books on the two-minute context cadence before they become stale",
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
  'const out = { verdict, paperMarginMon: typeof v.paperMarginMon === "number" && Number.isFinite(v.paperMarginMon) ? v.paperMarginMon : null, reason: typeof v.reason === "string" ? v.reason.slice(0, 240) : "No usable Gemini reason.", flags:',
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
  '    const sizingMaxLeverage = Number(LEVERUP_MARKET_MAX_LEVERAGE[candidate.symbol]);\n    const sizingLeverage = sizingMaxLeverage >= 100 ? 100 : PAPER_LEVERAGE;\n    const sizingMinimumMargin = minimumMarginForMarketLeverage(sizingMaxLeverage);\n    const sizingLimits = paperMarginLimits(sizingMinimumMargin, paperCash, paperStartingBalance, sizingLeverage, candidate.stopPct, openPaperRiskMon);\n    if (!sizingLimits.feasible) { console.log("Ciel skipped " + candidate.symbol + ": minimum margin or stop-risk exceeds the remaining 100 MON paper budget."); continue; }\n    const reviewed = candidate.mode === "RANGE_SCALP"\n      ? { verdict: "WAIT", reason: "Range scalp passed deterministic regime, CCI/rejection, statistical forecast and market-quality gates; Gemini review intentionally skipped to conserve daily API quota.", flags: ["LOCAL_RANGE_SCALP_REVIEW"], model: "CIEL deterministic range guard", queries: [], sources: [], paperMarginMon: null }\n      : await review(env,candidate,forecast,reviewerMarket,intraday,eventIntel,sizingLimits);',
  "calculate the candidate-specific size ceiling before asking Gemini",
);
replaceExactlyOnce(
  'const collateral = minimumMarginForMarketLeverage(marketMaxLeverage);\n    const leverage = marketMaxLeverage >= 100 ? 100 : PAPER_LEVERAGE;',
  'const collateral = choosePaperMargin(reviewed.verdict === "APPROVE" ? reviewed.paperMarginMon : null, sizingLimits);\n    const marginSizingSource = reviewed.verdict === "APPROVE" && typeof reviewed.paperMarginMon === "number" && Number.isFinite(reviewed.paperMarginMon) ? "GEMINI_AI" : "MINIMUM_FALLBACK";\n    const leverage = marketMaxLeverage >= 100 ? 100 : PAPER_LEVERAGE;\n    if (!Number.isFinite(collateral) || collateral + 1e-9 < sizingLimits.minMarginMon || collateral > sizingLimits.maxMarginMon + 1e-9) { console.log("Ciel skipped " + candidate.symbol + ": AI margin could not be safely clamped."); continue; }',
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

replaceExactlyOnce(
  '      lastMessageAt: this.lastMessageAt || null,\n      lastPongAt: this.lastPongAt || null,\n      lastPingAt: this.lastPingAt || null,\n      lastMessageAt: this.lastMessageAt || null,',
  '      lastMessageAt: this.lastMessageAt || null,\n      lastPongAt: this.lastPongAt || null,\n      lastPingAt: this.lastPingAt || null,',
  "remove duplicate lastMessageAt property from the staging bundle without altering recovered evidence",
);


function replaceExactlyN(before, after, expected, label) {
  const count = source.split(before).length - 1;
  if (count !== expected) throw new Error(label + ": expected " + expected + " matches, found " + count + ". Refusing to patch.");
  source = source.replaceAll(before, after);
  console.log("Applied staging patch: " + label);
}
replaceExactlyOnce(
  'const webhookUrl = "https://ciel.leno3z4rrrri.workers.dev/telegram/webhook";',
  'const expectedBotId = (env.TELEGRAM_STAGING_BOT_ID || "").trim();\n  if (!expectedBotId) return;\n  const identityResponse = await fetch("https://api.telegram.org/bot" + token + "/getMe", { signal: AbortSignal.timeout(8e3) });\n  const identityPayload = await identityResponse.json().catch(() => ({}));\n  if (!identityResponse.ok || identityPayload.ok !== true || String(identityPayload.result?.id || "") !== expectedBotId) throw new Error("Configured Telegram token does not match TELEGRAM_STAGING_BOT_ID; webhook registration refused.");\n  let webhookUrl;\n  try { const target = new URL(env.TELEGRAM_WEBHOOK_URL || ""); if (target.protocol !== "https:" || target.hostname !== "ciel2.gatakehanami.workers.dev" || target.pathname !== "/telegram/webhook") return; webhookUrl = target.toString(); } catch { return; }',
  "require an explicitly identified staging bot and staging-only webhook URL"
);
replaceExactlyOnce(
  'if (url.pathname === "/api/markets") {',
  'if (url.pathname === "/api/paper") {\n      try {\n        const response = await feedStub2(env).fetch("https://feed/paper/profits");\n        const summary = await response.json().catch(() => ({}));\n        if (!response.ok || summary.ok !== true) return json2({ ok: false, error: "Paper ledger unavailable", detail: summary.detail || summary.error || "Durable Object returned HTTP " + response.status }, 503);\n        return json2({ ...summary, mode: "paper-only", readOnly: true });\n      } catch (error) { return json2({ ok: false, error: "Paper ledger unavailable", detail: String(error).slice(0, 250) }, 503); }\n    }\n    if (url.pathname === "/api/diagnostics") {\n      try {\n        const tableResult = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type=\'table\' AND name NOT LIKE \'sqlite_%\' ORDER BY name").all();\n        const tables = (tableResult.results || []).map((row) => String(row.name));\n        const requiredTables = ["advisor_ai_audit","advisor_positions","live_executions","live_positions","market_alerts","market_book_snapshots","market_candle_hourly_stats","market_candles","market_context_snapshots","market_samples","market_snapshots","paper_executions","positions","signals","tokens","trades"];\n        const missingTables = requiredTables.filter((name) => !tables.includes(name));\n        const tableStats = {};\n        const statsQueries = { market_samples: "SELECT COUNT(*) AS rows,MIN(ts_ms) AS first_ts,MAX(ts_ms) AS last_ts FROM market_samples", market_candles: "SELECT COUNT(*) AS rows,MIN(open_ts_ms) AS first_ts,MAX(open_ts_ms) AS last_ts FROM market_candles", market_context_snapshots: "SELECT COUNT(*) AS rows,MIN(ts_ms) AS first_ts,MAX(ts_ms) AS last_ts FROM market_context_snapshots", market_candle_hourly_stats: "SELECT COUNT(*) AS rows,MIN(bucket_ms) AS first_ts,MAX(bucket_ms) AS last_ts FROM market_candle_hourly_stats", market_alerts: "SELECT COUNT(*) AS rows,MIN(created_at_ms) AS first_ts,MAX(created_at_ms) AS last_ts FROM market_alerts", advisor_ai_audit: "SELECT COUNT(*) AS rows,MIN(created_at_ms) AS first_ts,MAX(created_at_ms) AS last_ts FROM advisor_ai_audit" };\n        for (const [name, sql] of Object.entries(statsQueries)) { if (!tables.includes(name)) { tableStats[name] = null; continue; } try { tableStats[name] = await env.DB.prepare(sql).first(); } catch (error) { tableStats[name] = { error: String(error).slice(0, 160) }; } }\n        const feed = await feedStatus(env);\n        const paperResponse = await feedStub2(env).fetch("https://feed/paper/profits");\n        const paper = await paperResponse.json().catch(() => ({}));\n        const marker = await env.CIEL_STATE.get("ciel:telegram:webhook:auto-registration").catch(() => null);\n        const geminiKeyCount = [env.GEMINI_API_KEY_1,env.GEMINI_API_KEY_2,env.GEMINI_API_KEY_3,env.GEMINI_API_KEY_4,env.GEMINI_API_KEY_5,env.GEMINI_API_KEY_6,env.GEMINI_API_KEY_7].filter((value) => String(value || "").trim()).length;\n        return json2({ ok: missingTables.length === 0, mode: "read-only-diagnostics", d1: { schemaOk: missingTables.length === 0, tableCount: tables.length, missingTables, tables, tableStats }, secrets: { geminiKeyCount, telegramBotTokenConfigured: Boolean(String(env.TELEGRAM_BOT_TOKEN || "").trim()), telegramChatIdConfigured: Boolean(String(env.TELEGRAM_CHAT_ID || "").trim()), telegramWebhookSecretConfigured: Boolean(String(env.TELEGRAM_WEBHOOK_SECRET || "").trim()), telegramStagingBotIdConfigured: Boolean(String(env.TELEGRAM_STAGING_BOT_ID || "").trim()), telegramWebhookUrlConfigured: Boolean(String(env.TELEGRAM_WEBHOOK_URL || "").trim()) }, telegramWebhookRegistrationMarkerPresent: Boolean(marker), feed: { connected: feed.payload?.connected === true, lastTickAt: Number(feed.payload?.lastTickAt || 0) || null, availableCount: Number(feed.payload?.availableCount || 0), bookCount: Number(feed.payload?.bookCount || 0) }, paper: paperResponse.ok && paper.ok === true ? { starterBalanceMon: paper.starterBalanceMon, availableBalanceMon: paper.availableBalanceMon, openMarginMon: paper.openMarginMon, realizedPnlMon: paper.realizedPnlMon, unrealizedPnlMon: paper.unrealizedPnlMon, totalPnlMon: paper.totalPnlMon, equityMon: paper.equityMon, openCount: paper.openCount, closedCount: paper.closedCount, wins: paper.wins, losses: paper.losses, fresh: paper.fresh } : { ok: false, error: paper.error || "Paper ledger unavailable" } });\n      } catch (error) { return json2({ ok: false, mode: "read-only-diagnostics", error: "Diagnostics unavailable", detail: String(error).slice(0, 300) }, 503); }\n    }\n    if (url.pathname === "/api/markets") {',
  "expose paper ledger and safe D1/secret diagnostics"
);
replaceExactlyOnce(
  'endpoints: ["/health", "/api/markets", "/api/alerts", "/api/candles", "/api/orderbook", "/api/positions", "/api/intraday", "/telegram/webhook"]',
  'endpoints: ["/health", "/api/markets", "/api/alerts", "/api/candles", "/api/orderbook", "/api/positions", "/api/intraday", "/api/paper", "/api/diagnostics", "/telegram/webhook"]',
  "advertise paper and diagnostics endpoints"
);
replaceExactlyOnce('  restRefreshInProgress = false;', '  restRefreshInProgress = false;\n  lastXyzQntRefreshAt = 0;\n  xyzQntMid = null;\n  historyBootstrapDone = false;\n  lastHistoryBootstrapAt = 0;', "add QNT alias and history bootstrap state");
replaceExactlyOnce('      this.state.storage.get("lastContextSnapshotPersistAt")', '      this.state.storage.get("lastContextSnapshotPersistAt"),\n      this.state.storage.get("xyzQntMid"),\n      this.state.storage.get("lastXyzQntRefreshAt"),\n      this.state.storage.get("historyBootstrapDone"),\n      this.state.storage.get("lastHistoryBootstrapAt")', "restore QNT and history bootstrap state");
replaceExactlyOnce('    this.lastContextSnapshotPersistAt = Number(values[21]) || 0;', '    this.lastContextSnapshotPersistAt = Number(values[21]) || 0;\n    this.xyzQntMid = values[22] || null;\n    this.lastXyzQntRefreshAt = Number(values[23]) || 0;\n    this.historyBootstrapDone = values[24] === true;\n    this.lastHistoryBootstrapAt = Number(values[25]) || 0;', "restore QNT and history bootstrap timestamps");
replaceExactlyOnce(
  '  async writeMarketContexts(now) {',
  '  async refreshXyzQnt(now) {\n    if (now - this.lastXyzQntRefreshAt < 60000) return;\n    this.lastXyzQntRefreshAt = now;\n    try {\n      const [midResponse, bookResponse] = await Promise.all([fetch(HYPERLIQUID_INFO, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "allMids", dex: "xyz" }), signal: AbortSignal.timeout(8000) }),fetch(HYPERLIQUID_INFO, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "l2Book", coin: "xyz:QNT" }), signal: AbortSignal.timeout(8000) })]);\n      if (!midResponse.ok) throw new Error("xyz allMids returned HTTP " + midResponse.status);\n      const mids = await midResponse.json(); const price = Number(mids?.["xyz:QNT"] ?? mids?.QNT);\n      if (!(price > 0 && Number.isFinite(price))) throw new Error("xyz allMids did not return xyz:QNT");\n      this.xyzQntMid = { price, ts_ms: now }; this.latest.QNT = price;\n      if (bookResponse.ok) { const payload = await bookResponse.json(); const levels = payload?.levels; const bid = Array.isArray(levels?.[0]) ? levels[0][0] : null; const ask = Array.isArray(levels?.[1]) ? levels[1][0] : null; const bidPrice = Number(bid?.px ?? bid?.[0]), askPrice = Number(ask?.px ?? ask?.[0]), bidSize = Number(bid?.sz ?? bid?.[1]), askSize = Number(ask?.sz ?? ask?.[1]); if (bidPrice > 0 && askPrice > bidPrice && bidSize >= 0 && askSize >= 0) { this.latestBooks.QNT = { ts_ms: now, source_ts_ms: Number(payload.time) || null, best_bid: bidPrice, best_ask: askPrice, bid_size: bidSize, ask_size: askSize, spread_bps: (askPrice - bidPrice) / ((askPrice + bidPrice) / 2) * 1e4 }; this.bookLastWrite.QNT = now; } }\n      await Promise.all([this.state.storage.put("latest", this.latest), this.state.storage.put("latestBooks", this.latestBooks), this.state.storage.put("xyzQntMid", this.xyzQntMid), this.state.storage.put("lastXyzQntRefreshAt", now)]);\n    } catch (error) { console.error("Hyperliquid xyz:QNT monitor-only refresh failed: " + String(error).slice(0, 200)); await this.state.storage.put("lastXyzQntRefreshAt", now).catch(() => void 0); }\n  }\n  async writeMarketContexts(now) {',
  "add one-minute xyz:QNT price and order-book refresh without fabricating derivatives context"
);
replaceExactlyOnce('  async samplePrices(now) {\n    const windowMinutes =', '  async samplePrices(now) {\n    await this.refreshXyzQnt(now);\n    const windowMinutes =', "refresh QNT alias before sampling");
replaceExactlyN('      this.latest = next;', '      this.latest = next;\n      if (this.xyzQntMid && Date.now() - Number(this.xyzQntMid.ts_ms || 0) <= 90000) this.latest.QNT = Number(this.xyzQntMid.price);', 1, "preserve fresh QNT alias across default-Dex allMids updates");
replaceExactlyOnce(
  '      const price = this.latest[symbol];\n      return {\n        symbol,\n        price: Number.isFinite(price) && price > 0 ? price : null,\n        available: Number.isFinite(price) && price > 0\n      };',
  '      const price = this.latest[symbol];\n      const contextRows = this.contextHistory[symbol] || [];\n      const context = contextRows[contextRows.length - 1];\n      const book = this.latestBooks[symbol];\n      const contextFresh = Boolean(context && now - Number(context.ts_ms) <= 180000 && [context.funding_rate,context.open_interest,context.day_ntl_volume,context.mark_px,context.oracle_px].every((value) => value !== null && value !== undefined && Number.isFinite(Number(value))));\n      const bookFresh = Boolean(book && now - Number(book.ts_ms) <= 180000);\n      const maxLeverage = Number(LEVERUP_MARKET_MAX_LEVERAGE[symbol] || 0);\n      return { symbol, price: Number.isFinite(price) && price > 0 ? price : null, available: Number.isFinite(price) && price > 0, priceSource: symbol === "QNT" ? "Hyperliquid xyz DEX allMids alias" : "Hyperliquid default DEX allMids", bookAvailable: bookFresh, advisorReady: contextFresh && bookFresh, paperEligible: maxLeverage === 50 || maxLeverage >= 100, eligibilityNote: symbol === "QNT" ? "Monitor-only: xyz:QNT has price and book data but no derivatives funding/OI/mark/oracle context; 5x is outside the supported paper tiers." : null };',
  "distinguish priced markets from advisor-ready and paper-eligible markets"
);
replaceExactlyOnce('      const nonCoreSymbols = allSymbols.filter((symbol) => !CANDLE_HISTORY_SYMBOLS.has(symbol));', '      const nonCoreSymbols = allSymbols.filter((symbol) => !CANDLE_HISTORY_SYMBOLS.has(symbol) && symbol !== "QNT");', "skip derivative candle fetch for spot-only QNT");
replaceExactlyOnce(
  '  async writeCandleSnapshots(now) {',
  '  async bootstrapBenchmarkHistory(now) {\n    if (this.historyBootstrapDone || now - this.lastHistoryBootstrapAt < 6 * 60 * 60 * 1000) return;\n    this.lastHistoryBootstrapAt = now; await this.state.storage.put("lastHistoryBootstrapAt", now).catch(() => void 0);\n    const startTime = now - 4 * 86400000;\n    try {\n      for (const symbol of CANDLE_HISTORY_SYMBOLS) {\n        const coverage = await this.env.DB.prepare("SELECT COUNT(*) AS n,MIN(ts_ms) AS first_ts FROM market_samples WHERE symbol=? AND ts_ms>=?").bind(symbol,startTime).first();\n        if (Number(coverage?.n || 0) >= 600 && Number(coverage?.first_ts || 0) <= now - 3 * 86400000) continue;\n        const response = await fetch(HYPERLIQUID_INFO, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "candleSnapshot", req: { coin: symbol, interval: "5m", startTime, endTime: now } }), signal: AbortSignal.timeout(15000) });\n        if (!response.ok) throw new Error(symbol + " candleSnapshot returned HTTP " + response.status);\n        const payload = await response.json(); const candles = Array.isArray(payload) ? payload : [payload]; const statements = []; let validCount = 0;\n        for (const raw of candles) { if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue; const openAt = Number(raw.t), closeAt = Number(raw.T || (openAt + 300000 - 1)); const open = Number(raw.o), high = Number(raw.h), low = Number(raw.l), close = Number(raw.c); if (!(openAt > 0 && closeAt >= openAt && [open,high,low,close].every((value) => Number.isFinite(value) && value > 0))) continue; validCount++; statements.push(this.env.DB.prepare("INSERT OR IGNORE INTO market_candles (symbol,interval,open_ts_ms,close_ts_ms,open_price,high_price,low_price,close_price,volume,trade_count,updated_at_ms) VALUES (? ,\'5m\',?,?,?,?,?,?,?,?,?)").bind(symbol,openAt,closeAt,open,high,low,close,Number(raw.v)||0,Number(raw.n)||0,now)); statements.push(this.env.DB.prepare("INSERT OR IGNORE INTO market_samples (ts_ms,symbol,mid_price) VALUES (?,?,?)").bind(closeAt,symbol,close)); }\n        if (validCount < 600) throw new Error(symbol + " historical candle response was too short (" + validCount + " rows)");\n        for (let offset = 0; offset < statements.length; offset += 100) await this.env.DB.batch(statements.slice(offset,offset + 100));\n        await this.env.DB.prepare("INSERT INTO market_candle_hourly_stats (symbol,bucket_ms,low_price,high_price,first_ts,last_ts,candle_count) SELECT symbol,CAST(open_ts_ms/3600000 AS INTEGER)*3600000,MIN(low_price),MAX(high_price),MIN(open_ts_ms),MAX(close_ts_ms),COUNT(*) FROM market_candles WHERE symbol=? AND interval=\'5m\' AND open_ts_ms>=? GROUP BY CAST(open_ts_ms/3600000 AS INTEGER) ON CONFLICT(symbol,bucket_ms) DO UPDATE SET low_price=MIN(market_candle_hourly_stats.low_price,excluded.low_price),high_price=MAX(market_candle_hourly_stats.high_price,excluded.high_price),first_ts=MIN(market_candle_hourly_stats.first_ts,excluded.first_ts),last_ts=MAX(market_candle_hourly_stats.last_ts,excluded.last_ts),candle_count=MAX(market_candle_hourly_stats.candle_count,excluded.candle_count)").bind(symbol,startTime).run();\n        console.info("Bootstrapped " + validCount + " native 5m candles for " + symbol + " into staging history.");\n      }\n      this.historyBootstrapDone = true; await this.state.storage.put("historyBootstrapDone",true);\n    } catch (error) { console.error("Benchmark candle-history bootstrap deferred: " + String(error).slice(0,250)); this.historyBootstrapDone = false; await this.state.storage.put("historyBootstrapDone",false).catch(() => void 0); }\n  }\n  async writeCandleSnapshots(now) {\n    await this.bootstrapBenchmarkHistory(now);',
  "bootstrap four days of benchmark candles and intraday samples with bounded D1 batches"
);
replaceExactlyOnce(
  '    const available = Number(state.availableBalanceMon ?? PAPER_STARTING_BALANCE_MON);',
  '    const available = Number(state.availableBalanceMon ?? PAPER_STARTING_BALANCE_MON);\n    const startingBalance = Number(state.startingBalanceMon ?? PAPER_STARTING_BALANCE_MON);\n    const stopPct = Number(params.stopPct);\n    if (!(selectedLeverage > 0 && Number.isFinite(stopPct) && stopPct > 0 && stopPct < 100)) { result = { opened: false, reason: "Paper stop or leverage is invalid.", availableBalanceMon: Number.isFinite(available) ? available : 0 }; return; }\n    const openRiskMon = (state.trades || []).filter((trade) => trade.status === "OPEN").reduce((sum, trade) => { const m = Number(trade.marginMon), l = Number(trade.leverage), s = Number(trade.stopPct); return sum + (m > 0 && l > 0 && s > 0 ? m * l * s / 100 : startingBalance); }, 0);\n    const proposedRiskMon = margin * selectedLeverage * stopPct / 100;\n    if (proposedRiskMon > startingBalance * 0.05 + 1e-9 || openRiskMon + proposedRiskMon > startingBalance * 0.10 + 1e-9) { result = { opened: false, reason: "Paper stop-risk exceeds the 5% per-trade or 10% combined portfolio cap.", availableBalanceMon: Number.isFinite(available) ? available : 0, proposedRiskMon, openRiskMon }; return; }',
  "enforce paper risk caps inside the ledger transaction"
);

replaceExactlyOnce(
  'const webhookUrl = new URL("/telegram/webhook", url.origin).toString();',
  'const expectedBotId = (env.TELEGRAM_STAGING_BOT_ID || "").trim();\n        if (!expectedBotId || url.hostname !== "ciel2.gatakehanami.workers.dev") return json2({ error: "Staging bot identity and staging host must be configured." }, 403);\n        const identityResponse = await fetch("https://api.telegram.org/bot" + botToken + "/getMe", { signal: AbortSignal.timeout(8e3) });\n        const identityPayload = await identityResponse.json().catch(() => ({}));\n        if (!identityResponse.ok || identityPayload.ok !== true || String(identityPayload.result?.id || "") !== expectedBotId) return json2({ error: "Telegram bot identity does not match TELEGRAM_STAGING_BOT_ID; webhook registration refused." }, 403);\n        const webhookUrl = new URL("/telegram/webhook", url.origin).toString();',
  "protect manual webhook registration with the staging bot identity check"
);

await writeFile(output, source);
console.log(`Wrote patched staging candidate: ${output}`);
console.log("Recovered source fragments and exact-bundle reconstruction remain unchanged.");
