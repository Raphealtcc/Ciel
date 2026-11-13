export function normalizePurgeSymbol(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return null;
  const normalized = raw.replace(/\.(P|PERP)$/,"").replace(/[-_/](USD|USDT|USDC|PERP)$/,"").replace(/(USDT|USDC|USD|PERP)$/,"").replace(/[^A-Z0-9]/g,"");
  if (!normalized) throw new Error("PURGE_SYMBOL_INVALID");
  return normalized;
}

export async function purgePaperTrades({ storage, accountKey, prices, now = Date.now(), lastTickAt = 0, symbol = null, maxAgeMs = 120000 }) {
  if (!storage?.get || !storage?.put || !accountKey) throw new Error("PAPER_PURGE_STORAGE_UNAVAILABLE");
  const target = normalizePurgeSymbol(symbol);
  const fresh = Number(lastTickAt) > 0 && now >= Number(lastTickAt) && now - Number(lastTickAt) <= maxAgeMs;
  const closed = [], skipped = [];
  await storage.transaction(async () => {
    const state = await storage.get(accountKey);
    if (!state || !Array.isArray(state.trades)) return;
    let changed = false;
    for (const trade of state.trades) {
      if (trade.status !== "OPEN") continue;
      const tradeSymbol = normalizePurgeSymbol(trade.symbol);
      if (target && tradeSymbol !== target) continue;
      const current = Number(prices?.[trade.symbol] ?? prices?.[String(trade.symbol || "").toUpperCase()]);
      const monUsd = Number(prices?.MON);
      if (!fresh || !(current > 0 && monUsd > 0 && Number(trade.entryPrice) > 0 && Number(trade.entryMonUsd) > 0)) {
        skipped.push({ symbol: trade.symbol, signalId: trade.signalId, reason: fresh ? "FRESH_MARK_UNAVAILABLE" : "STALE_MARKET_DATA" });
        continue;
      }
      const direction = trade.side === "SHORT" ? -1 : 1;
      const movePct = direction * ((current - Number(trade.entryPrice)) / Number(trade.entryPrice)) * 100;
      const marginMon = Number(trade.marginMon) || 0;
      const marginUsd = marginMon * Number(trade.entryMonUsd);
      const notionalUsd = marginUsd * Number(trade.leverage || 0);
      const grossPnlUsd = notionalUsd * movePct / 100;
      const exitNotionalUsd = notionalUsd * current / Number(trade.entryPrice);
      const feeUsd = Math.max(0, (notionalUsd + exitNotionalUsd) * 0.0003);
      const feeMon = feeUsd / monUsd;
      const grossPnlMon = grossPnlUsd / monUsd;
      const pnlMon = Math.max(-marginMon, grossPnlMon - feeMon);
      const pnlUsd = pnlMon * monUsd;
      state.availableBalanceMon = Number(state.availableBalanceMon || 0) + marginMon + pnlMon;
      state.realizedPnlMon = Number(state.realizedPnlMon || 0) + pnlMon;
      state.realizedPnlUsd = Number(state.realizedPnlUsd || 0) + pnlUsd;
      state.closedCount = Number(state.closedCount || 0) + 1;
      if (pnlMon > 0) state.wins = Number(state.wins || 0) + 1;
      else if (pnlMon < 0) state.losses = Number(state.losses || 0) + 1;
      else state.breakeven = Number(state.breakeven || 0) + 1;
      trade.status = "CLOSED";
      trade.exitPrice = current;
      trade.exitMonUsd = monUsd;
      trade.closedAtMs = now;
      trade.closeReason = "MANUAL_PURGE";
      trade.grossPnlMon = grossPnlMon;
      trade.grossPnlUsd = grossPnlUsd;
      trade.feeMon = feeMon;
      trade.feeUsd = feeUsd;
      trade.netPnlMon = pnlMon;
      trade.netPnlUsd = pnlUsd;
      trade.feeModelVersion = "LEVERUP_TAKER_3BPS_EACH_SIDE_V1";
      trade.returnOnMarginPct = marginMon > 0 ? pnlMon / marginMon * 100 : 0;
      closed.push({ symbol: trade.symbol, side: trade.side, signalId: trade.signalId, exitPrice: current, pnlMon, pnlUsd, grossPnlMon, feeMon, roiPct: trade.returnOnMarginPct });
      changed = true;
    }
    if (changed) {
      state.trades = state.trades.slice(0, 1000);
      state.updatedAtMs = now;
      await storage.put(accountKey, state);
    }
  });
  return { status: skipped.length ? (closed.length ? "PARTIAL" : "BLOCKED_STALE_OR_MISSING_MARKS") : (closed.length ? "CLOSED" : "NO_MATCHING_OPEN_TRADES"), requestedSymbol: target, closed, skipped, closedCount: closed.length, skippedCount: skipped.length };
}
