import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const file=path.join(process.cwd(),"reconstructed","patched-worker.js");
let source=await readFile(file,"utf8");
function once(before,after,label){const n=source.split(before).length-1;if(n!==1)throw new Error(label+": expected one match, found "+n);source=source.replace(before,after);}
once('const paperState = paperStorage ? await paperStorage.get(PAPER_ACCOUNT_KEY) : null;','const paperState = paperStorage ? await paperStorage.get(PAPER_ACCOUNT_KEY) : null;\n  const paperOverride = await readTradingControl(env, "ciel:control:paper-enabled", null);\n  const paperTradingEnabled = String(paperOverride ?? env?.PAPER_TRADING_ENABLED ?? "false").toLowerCase() === "true";',"paper toggle");
once(
'if (sym === "MON") { scanDiagnostics.push({symbol:sym,reason:"NON_TRADEABLE_BASE_ASSET"}); continue; }\n    if (requiredPaperMargin === null) { scanDiagnostics.push({symbol:sym,reason:"BELOW_50X_OR_UNSUPPORTED_LEVERAGE_TIER"}); continue; }\n    if (paperCash + 1e-9 < requiredPaperMargin) { scanDiagnostics.push({symbol:sym,reason:"INSUFFICIENT_FREE_MARGIN",requiredPaperMargin,availablePaperMargin:paperCash}); continue; }\n    if (openPaperSymbols.has(sym)) { scanDiagnostics.push({symbol:sym,reason:"POSITION_ALREADY_OPEN"}); continue; }',
'if (sym === "MON") { scanDiagnostics.push({symbol:sym,reason:"NON_TRADEABLE_BASE_ASSET"}); continue; }\n    if (requiredPaperMargin === null) scanDiagnostics.push({symbol:sym,reason:"PAPER_MARKET_TIER_UNSUPPORTED"});\n    if (paperCash + 1e-9 < requiredPaperMargin) scanDiagnostics.push({symbol:sym,reason:"PAPER_INSUFFICIENT_FREE_MARGIN",requiredPaperMargin,availablePaperMargin:paperCash});\n    if (openPaperSymbols.has(sym)) scanDiagnostics.push({symbol:sym,reason:"PAPER_POSITION_ALREADY_OPEN"});',"candidate independence");
once('if (!sizingLimits.feasible) { console.log("Ciel skipped " + candidate.symbol + ": minimum margin or stop-risk exceeds the remaining 100 MON paper budget."); continue; }','if (paperTradingEnabled && !sizingLimits.feasible) scanDiagnostics.push({symbol:candidate.symbol,reason:"PAPER_SIZE_UNAVAILABLE",minMarginMon:sizingLimits.minMarginMon,maxMarginMon:sizingLimits.maxMarginMon});',"paper sizing no longer blocks live");
once(
'const collateral = choosePaperMargin(reviewed.verdict === "APPROVE" ? reviewed.paperMarginMon : null, sizingLimits);\n    const marginSizingSource = reviewed.verdict === "APPROVE" && typeof reviewed.paperMarginMon === "number" && Number.isFinite(reviewed.paperMarginMon) ? "GEMINI_AI" : "MINIMUM_FALLBACK";\n    const leverage = marketMaxLeverage >= 100 ? 100 : PAPER_LEVERAGE;\n    if (!Number.isFinite(collateral) || collateral + 1e-9 < sizingLimits.minMarginMon || collateral > sizingLimits.maxMarginMon + 1e-9) { console.log("Ciel skipped " + candidate.symbol + ": AI margin could not be safely clamped."); continue; }',
'const selectedPaperMargin = paperTradingEnabled && sizingLimits.feasible ? choosePaperMargin(reviewed.verdict === "APPROVE" ? reviewed.paperMarginMon : null, sizingLimits) : null;\n    const collateral = Number.isFinite(selectedPaperMargin) ? selectedPaperMargin : (Number.isFinite(sizingMinimumMargin) ? sizingMinimumMargin : 0);\n    const marginSizingSource = !paperTradingEnabled ? "PAPER_DISABLED" : Number.isFinite(selectedPaperMargin) ? (reviewed.verdict === "APPROVE" && typeof reviewed.paperMarginMon === "number" && Number.isFinite(reviewed.paperMarginMon) ? "GEMINI_AI" : "MINIMUM_FALLBACK") : "PAPER_SIZE_UNAVAILABLE";\n    const leverage = marketMaxLeverage >= 100 ? 100 : PAPER_LEVERAGE;',"paper margin decoupled");
once(
'const rationale = candidate.reason + " " + forecastSummary + " " + reviewSummary + timingSummary + " Margin sizing: " + marginSizingSource + " selected " + collateral.toFixed(3) + " MON inside a " + sizingLimits.minMarginMon + "–" + sizingLimits.maxMarginMon + " MON range; per-trade stop-risk cap " + sizingLimits.tradeRiskBudgetMon.toFixed(2) + " MON, portfolio cap " + sizingLimits.portfolioRiskBudgetMon.toFixed(2) + " MON. Strategy " + candidate.mode + "; technical strength model v3: " + (candidate.confidence * 100).toFixed(0) + "/100 across " + (candidate.scoreComponents || []).join("+") + "; not a win probability." + (technicalOnly ? " Technical-only fallback; confirmation incomplete." : "");',
'const rationale = candidate.reason + " " + forecastSummary + " " + reviewSummary + timingSummary + (paperTradingEnabled ? " Paper margin sizing: " + marginSizingSource + " selected " + collateral.toFixed(3) + " MON inside a " + sizingLimits.minMarginMon + "–" + sizingLimits.maxMarginMon + " MON range." : " Paper trading is paused; no paper margin is reserved. Live margin is selected independently from LeverUp account, venue and portfolio data.") + " Strategy " + candidate.mode + "; technical strength model v3: " + (candidate.confidence * 100).toFixed(0) + "/100 across " + (candidate.scoreComponents || []).join("+") + "; not a win probability." + (technicalOnly ? " Technical-only fallback; confirmation incomplete." : "");',"proposal copy");
once('mon_collateral: collateral, leverage, margin_sizing_source: marginSizingSource, entry_mon_usd: monUsdPrice, manual_entry_at_ms: null };','mon_collateral: collateral, leverage, margin_sizing_source: marginSizingSource, paper_trading_enabled: paperTradingEnabled, entry_mon_usd: monUsdPrice, manual_entry_at_ms: null };',"paper flag on setup object");
{
  const start = source.indexOf("      let paperResult = null;");
  const end = source.indexOf("\n      const paperLine", start);
  if (start < 0 || end < 0) throw new Error("paper entry block boundaries not found after preceding patches");
  const block = source.slice(start, end);
  const call = block.match(/paperResult = await openPaperTrade\(paperStorage, \{[\s\S]*?\}\);/);
  if (!call) throw new Error("paper entry call not found after preceding patches");
  if (!block.includes("Automatic paper entry failed for ")) throw new Error("paper entry error handler not found");
  const gated = `      let paperResult = null;
      if (paperTradingEnabled && sizingLimits.feasible) {
        try {
          ${call[0]}
        } catch (error) {
          console.error("Automatic paper entry failed for " + candidate.symbol + ": " + String(error).slice(0, 250));
        }
      } else if (paperTradingEnabled) {
        paperResult = { opened: false, reason: "Paper sizing unavailable; live candidate processing was not blocked." };
      }`;
  source = source.slice(0, start) + gated + source.slice(end);
  console.log("Applied paper/live isolation: gate only the paper ledger entry");
}

once('const paperLine = paperResult?.opened','const paperLine = !paperTradingEnabled ? "\\n\\n🧪 PAPER TRADING PAUSED — no new paper entries will open. Existing paper positions will continue to be managed; historical trades remain available to adaptive learning." : paperResult?.opened',"paper pause notification");
once('"AI-sized paper margin (" + (p.margin_sizing_source || "MINIMUM_FALLBACK") + "): " + p.mon_collateral.toFixed(3) + " MON at live MON $"','p.paper_trading_enabled === false ? "Paper trading: PAUSED; no simulated margin reserved." : "AI-sized paper margin (" + (p.margin_sizing_source || "MINIMUM_FALLBACK") + "): " + p.mon_collateral.toFixed(3) + " MON at live MON $"',"hide paused margin");
await writeFile(file,source);
