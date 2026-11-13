import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const file = path.join(process.cwd(), "reconstructed", "patched-worker.js");
let source = await readFile(file, "utf8");

function once(before, after, label) {
  const count = source.split(before).length - 1;
  if (count === 0 && source.includes(after)) return;
  if (count !== 1) throw new Error(label + ": expected one match, found " + count);
  source = source.replace(before, after);
}

once(`function paperTradePnl(trade, currentPrice, currentMonUsd) {
  const entry = Number(trade.entryPrice), current = Number(currentPrice), monUsd = Number(currentMonUsd);
  if (!(entry > 0 && current > 0 && monUsd > 0 && Number(trade.entryMonUsd) > 0)) return null;
  const direction = trade.side === "LONG" ? 1 : -1;
  const movePct = direction * ((current - entry) / entry) * 100;
  const marginUsd = Number(trade.marginMon) * Number(trade.entryMonUsd);
  const notionalUsd = marginUsd * Number(trade.leverage);
  const pnlUsd = notionalUsd * movePct / 100;
  const pnlMon = pnlUsd / monUsd;
  return { movePct, usd: pnlUsd, mon: pnlMon, roiPct: Number(trade.marginMon) > 0 ? pnlMon / Number(trade.marginMon) * 100 : 0, marginUsd, notionalUsd };
}`,
`function paperTradePnl(trade, currentPrice, currentMonUsd) {
  const entry = Number(trade.entryPrice), current = Number(currentPrice), monUsd = Number(currentMonUsd);
  if (!(entry > 0 && current > 0 && monUsd > 0 && Number(trade.entryMonUsd) > 0)) return null;
  const direction = trade.side === "LONG" ? 1 : -1;
  const movePct = direction * ((current - entry) / entry) * 100;
  const marginUsd = Number(trade.marginMon) * Number(trade.entryMonUsd);
  const notionalUsd = marginUsd * Number(trade.leverage);
  const grossUsd = notionalUsd * movePct / 100;
  const exitNotionalUsd = notionalUsd * current / entry;
  // LeverUp preflight snapshots report an 3 bps open/close fee from LeverUp preflight; paper mode uses that measured rate.
  const feeRate = 0.0003;
  const feeUsd = Math.max(0, (notionalUsd + exitNotionalUsd) * feeRate);
  const grossMon = grossUsd / monUsd;
  const feeMon = feeUsd / monUsd;
  const netUsd = grossUsd - feeUsd;
  const netMon = netUsd / monUsd;
  return { movePct, usd: netUsd, mon: netMon, grossUsd, grossMon, feeUsd, feeMon, netUsd, netMon, feeRate, roiPct: Number(trade.marginMon) > 0 ? netMon / Number(trade.marginMon) * 100 : 0, marginUsd, notionalUsd };
}`,
"deduct estimated 3 bps entry and exit fees from paper P&L");

once(`        if (protection.trigger) {
          reason = "PROFIT_PROTECTION";
          exitPrice = current;
        }`,
`        if (protection.trigger) {
          const feeAwareProfit = paperTradePnl(trade, current, Number(prices.MON));
          if (feeAwareProfit && feeAwareProfit.mon >= 0.15) {
            reason = "PROFIT_PROTECTION";
            exitPrice = current;
          } else {
            trade.profitProtectionSamples = 0;
            trade.profitProtectionBreachAtMs = 0;
            trade.profitProtectionLastSampleAtMs = 0;
            changed = true;
          }
        }`,
"require positive fee-adjusted profit before profit-protection exits");

once(`      trade.status = "CLOSED"; trade.exitPrice = exitPrice; trade.exitMonUsd = Number(prices.MON);
      trade.closedAtMs = now; trade.closeReason = reason; trade.grossPnlMon = pnlMon;
      trade.grossPnlUsd = pnlUsd;
      trade.returnOnMarginPct = Number(trade.marginMon) > 0 ? pnlMon / Number(trade.marginMon) * 100 : 0;`,
`      trade.status = "CLOSED"; trade.exitPrice = exitPrice; trade.exitMonUsd = Number(prices.MON);
      trade.closedAtMs = now; trade.closeReason = reason;
      trade.grossPnlMon = Number.isFinite(Number(pnl.grossMon)) ? pnl.grossMon : pnlMon;
      trade.grossPnlUsd = Number.isFinite(Number(pnl.grossUsd)) ? pnl.grossUsd : pnlUsd;
      trade.feeMon = Number(pnl.feeMon) || 0;
      trade.feeUsd = Number(pnl.feeUsd) || 0;
      trade.netPnlMon = pnlMon;
      trade.netPnlUsd = pnlMon * Number(prices.MON);
      trade.feeModelVersion = "LEVERUP_TAKER_3BPS_EACH_SIDE_V1";
      trade.returnOnMarginPct = Number(trade.marginMon) > 0 ? pnlMon / Number(trade.marginMon) * 100 : 0;`,
"persist gross, fee and net settlement values");

once(`      lines.push(trade.side + " " + trade.symbol + " | " + trade.reason,
        "Simulated exit $" + fmt(trade.exitPrice) + " | P&L " + sign(trade.pnlMon) + " MON ($" + sign(trade.pnlUsd) + ")",
        "Return on margin: " + sign(trade.roiPct) + "% | signal " + trade.signalId);`,
`      lines.push(trade.side + " " + trade.symbol + " | " + trade.reason,
        "Simulated exit $" + fmt(trade.exitPrice) + " | NET P&L " + sign(trade.pnlMon) + " MON ($" + sign(trade.pnlUsd) + ")",
        "Estimated entry+exit fees deducted; return on margin: " + sign(trade.roiPct) + "% | signal " + trade.signalId);`,
"show net P&L in paper close notifications");

once('"Gross Hyperliquid-mid paper result; LeverUp Pyth/pool fills, fees, funding/holding fees, oracle costs, slippage, collateral CR, minimum-hold restrictions and liquidation are excluded."',
'"Net mark-based paper result after estimated 3 bps-per-side trading fees. Funding, holding fees, oracle costs, slippage, collateral CR, minimum-hold restrictions and liquidation remain excluded."',
"replace gross-only paper disclaimer");

once('const availableBalanceMon = Number(state.availableBalanceMon ?? state.startingBalanceMon ?? PAPER_STARTING_BALANCE_MON);',
'let availableBalanceMon = Number(state.availableBalanceMon ?? state.startingBalanceMon ?? PAPER_STARTING_BALANCE_MON);',
"allow fee migration to update the returned available balance");
once('const totalPnlMon = allMarksAvailable ? Number(state.realizedPnlMon || 0) + unrealizedPnlMon : null;',
'let totalPnlMon = allMarksAvailable ? Number(state.realizedPnlMon || 0) + unrealizedPnlMon : null;',
"allow fee migration to update total paper P&L");
once('const equityMon = totalPnlMon === null ? null : startingBalanceMon + totalPnlMon;',
'let equityMon = totalPnlMon === null ? null : startingBalanceMon + totalPnlMon;',
"allow fee migration to update paper equity");

once(`  const closedTrades = (state.trades || []).filter((trade) => trade.status === "CLOSED");
  const modeStats = (mode) => {`,
`  const closedTrades = (state.trades || []).filter((trade) => trade.status === "CLOSED");
  // One-time migration: retain all trades, but recalculate historical realized P&L after estimated entry/exit fees.
  let feeMigrationChanged = false, legacyFeeDataUnavailable = 0;
  for (const trade of closedTrades) {
    if (trade.feeModelVersion === "LEVERUP_TAKER_3BPS_EACH_SIDE_V1") continue;
    if (trade.feeModelVersion === "LEGACY_FEE_DATA_UNAVAILABLE") {
      legacyFeeDataUnavailable += 1;
      continue;
    }
    const historical = paperTradePnl(trade, Number(trade.exitPrice), Number(trade.exitMonUsd) || monUsd);
    if (historical) {
      trade.grossPnlMon = Number.isFinite(Number(trade.grossPnlMon)) ? Number(trade.grossPnlMon) : historical.grossMon;
      trade.grossPnlUsd = Number.isFinite(Number(trade.grossPnlUsd)) ? Number(trade.grossPnlUsd) : historical.grossUsd;
      trade.feeMon = historical.feeMon;
      trade.feeUsd = historical.feeUsd;
      trade.netPnlMon = Math.max(-Number(trade.marginMon || 0), historical.netMon);
      trade.netPnlUsd = trade.netPnlMon * (Number(trade.exitMonUsd) || monUsd);
      trade.feeModelVersion = "LEVERUP_TAKER_3BPS_EACH_SIDE_V1";
      trade.returnOnMarginPct = Number(trade.marginMon) > 0 ? trade.netPnlMon / Number(trade.marginMon) * 100 : 0;
    } else {
      trade.netPnlMon = Number(trade.grossPnlMon) || 0;
      trade.netPnlUsd = Number(trade.grossPnlUsd) || 0;
      trade.feeMon = 0;
      trade.feeUsd = 0;
      trade.feeModelVersion = "LEGACY_FEE_DATA_UNAVAILABLE";
      legacyFeeDataUnavailable += 1;
    }
    feeMigrationChanged = true;
  }
  if (feeMigrationChanged) {
    const netRealized = closedTrades.reduce((sum, trade) => sum + (Number(trade.netPnlMon ?? trade.grossPnlMon) || 0), 0);
    const netWins = closedTrades.filter((trade) => Number(trade.netPnlMon ?? trade.grossPnlMon) > 0).length;
    const netLosses = closedTrades.filter((trade) => Number(trade.netPnlMon ?? trade.grossPnlMon) < 0).length;
    state.realizedPnlMon = netRealized;
    state.realizedPnlUsd = closedTrades.reduce((sum, trade) => sum + (Number(trade.netPnlUsd ?? trade.grossPnlUsd) || 0), 0);
    state.availableBalanceMon = startingBalanceMon + netRealized - openMarginMon;
    state.wins = netWins;
    state.losses = netLosses;
    state.breakeven = closedTrades.length - netWins - netLosses;
    state.updatedAtMs = now;
    await storage.put(PAPER_ACCOUNT_KEY, state);
    availableBalanceMon = Number(state.availableBalanceMon);
    totalPnlMon = allMarksAvailable ? Number(state.realizedPnlMon || 0) + unrealizedPnlMon : null;
    equityMon = totalPnlMon === null ? null : startingBalanceMon + totalPnlMon;
  }
  const modeStats = (mode) => {`,
"recalculate historical paper balance once without deleting trade history");

once('const wins = matches.filter((trade) => Number(trade.grossPnlMon) > 0).length;',
'const wins = matches.filter((trade) => Number(trade.netPnlMon ?? trade.grossPnlMon) > 0).length;',
"count net strategy wins");
once('const losses = matches.filter((trade) => Number(trade.grossPnlMon) < 0).length;',
'const losses = matches.filter((trade) => Number(trade.netPnlMon ?? trade.grossPnlMon) < 0).length;',
"count net strategy losses");
once('const breakeven = matches.filter((trade) => Number(trade.grossPnlMon) === 0).length;',
'const breakeven = matches.filter((trade) => Number(trade.netPnlMon ?? trade.grossPnlMon) === 0).length;',
"count net break-even trades");
once('const pnl = matches.reduce((sum, trade) => sum + (Number(trade.grossPnlMon) || 0), 0);',
'const pnl = matches.reduce((sum, trade) => sum + (Number(trade.netPnlMon ?? trade.grossPnlMon) || 0), 0);',
"report net strategy P&L");

once('"Paper results use Hyperliquid mids, not LeverUp Pyth/pool fills. Fees, funding/holding fees, oracle costs, slippage, collateral CR, minimum-hold restrictions and liquidation are not simulated."',
'"Paper results use Hyperliquid mids, not LeverUp Pyth/pool fills. Estimated 3 bps-per-side trading fees are deducted; funding/holding fees, oracle costs, slippage, collateral CR, minimum-hold restrictions and liquidation are not simulated."',
"update /profits cost disclosure");

once('    openCount: openTrades.length, closedCount: Number(state.closedCount || 0),',
'    openCount: openTrades.length, closedCount: Number(state.closedCount || 0),\n    feeDataUnavailableCount: closedTrades.filter((trade) => trade.feeModelVersion === "LEGACY_FEE_DATA_UNAVAILABLE").length,',
"expose legacy trades without a usable fee basis");

await writeFile(file, source);
console.log("Applied fee-aware paper accounting and one-time historical migration.");
