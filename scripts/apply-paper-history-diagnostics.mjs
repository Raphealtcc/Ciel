import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const file = path.join(process.cwd(), "reconstructed", "patched-worker.js");
let source = await readFile(file, "utf8");

function once(text, before, after, label) {
  const count = text.split(before).length - 1;
  if (count === 0 && text.includes(after)) return text;\n  if (count !== 1) throw new Error(label + ": expected exactly one match, found " + count);
  return text.replace(before, after);
}

source = once(source,
  "function getPaperSummary(storage, prices, now, lastTickAt) {",
  "function getPaperSummary(storage, prices, now, lastTickAt, includeHistory = false) {",
  "add opt-in history parameter to paper summary",
);

source = once(source,
  `const recentClosed = closedTrades.slice(0, 5).map((trade) => ({
    signalId: trade.signalId, symbol: trade.symbol, side: trade.side,
    mode: trade.mode || "LEGACY", regime: trade.regime || null,
    leverage: trade.leverage, marginMon: trade.marginMon, entryPrice: trade.entryPrice,
    exitPrice: trade.exitPrice, closeReason: trade.closeReason,
    pnlMon: trade.feeModelVersion === "LEGACY_FEE_DATA_UNAVAILABLE" ? null : (trade.netPnlMon ?? null),
    grossPnlMon: trade.grossPnlMon,
    feeMon: trade.feeMon ?? null,
    netPnlMon: trade.feeModelVersion === "LEGACY_FEE_DATA_UNAVAILABLE" ? null : (trade.netPnlMon ?? null),
    feeModelVersion: trade.feeModelVersion || null,
    feeDataUnavailable: trade.feeModelVersion === "LEGACY_FEE_DATA_UNAVAILABLE",
    pnlUsd: trade.feeModelVersion === "LEGACY_FEE_DATA_UNAVAILABLE" ? null : (trade.netPnlUsd ?? null),
    returnOnMarginPct: trade.returnOnMarginPct, closedAtMs: trade.closedAtMs
  }));`,
  `const historyTrades = includeHistory
    ? closedTrades.slice().sort((a, b) => Number(b.closedAtMs) - Number(a.closedAtMs)).slice(0, 250)
    : closedTrades.slice(0, 5);
  const recentClosed = historyTrades.map((trade) => ({
    signalId: trade.signalId,
    symbol: trade.symbol,
    side: trade.side,
    mode: trade.mode || "LEGACY",
    regime: trade.regime || null,
    strategy: trade.strategy || null,
    confidence: Number.isFinite(Number(trade.confidence)) ? Number(trade.confidence) : null,
    leverage: trade.leverage,
    marginMon: trade.marginMon,
    entryPrice: trade.entryPrice,
    exitPrice: trade.exitPrice,
    closeReason: trade.closeReason,
    pnlMon: trade.feeModelVersion === "LEGACY_FEE_DATA_UNAVAILABLE" ? null : (trade.netPnlMon ?? trade.grossPnlMon),
    grossPnlMon: trade.grossPnlMon,
    feeMon: trade.feeMon || 0,
    netPnlMon: trade.feeModelVersion === "LEGACY_FEE_DATA_UNAVAILABLE" ? null : (trade.netPnlMon ?? trade.grossPnlMon),
    feeModelVersion: trade.feeModelVersion || null,
    feeDataUnavailable: trade.feeModelVersion === "LEGACY_FEE_DATA_UNAVAILABLE",
    pnlUsd: trade.feeModelVersion === "LEGACY_FEE_DATA_UNAVAILABLE" ? null : (trade.netPnlUsd ?? trade.grossPnlUsd),
    returnOnMarginPct: trade.returnOnMarginPct,
    stopPct: Number.isFinite(Number(trade.stopPct)) ? Number(trade.stopPct) : null,
    targetPct: Number.isFinite(Number(trade.targetPct)) ? Number(trade.targetPct) : null,
    bestFavorableMovePct: Number.isFinite(Number(trade.bestFavorableMovePct)) ? Number(trade.bestFavorableMovePct) : null,
    worstAdverseMovePct: Number.isFinite(Number(trade.worstAdverseMovePct)) ? Number(trade.worstAdverseMovePct) : null,
    openedAtMs: Number(trade.openedAtMs) || null,
    closedAtMs: trade.closedAtMs,
    durationMinutes: Number(trade.openedAtMs) > 0 && Number(trade.closedAtMs) >= Number(trade.openedAtMs)
      ? (Number(trade.closedAtMs) - Number(trade.openedAtMs)) / 60000 : null
  }));
  const historyAnalysis = includeHistory ? (() => {
    const pricedClosed = recentClosed.filter((trade) => trade.pnlMon !== null && trade.pnlMon !== undefined);
    const feeDataUnavailableCount = recentClosed.filter((trade) => trade.feeDataUnavailable).length;
    const group = (field) => {
      const buckets = new Map();
      for (const trade of pricedClosed) {
        const key = String(trade[field] || "UNKNOWN");
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(trade);
      }
      return [...buckets.entries()].map(([key, rows]) => ({
        key,
        trades: rows.length,
        wins: rows.filter((trade) => Number(trade.pnlMon) > 0).length,
        losses: rows.filter((trade) => Number(trade.pnlMon) < 0).length,
        totalPnlMon: rows.reduce((sum, trade) => sum + (Number(trade.pnlMon) || 0), 0),
        averagePnlMon: rows.reduce((sum, trade) => sum + (Number(trade.pnlMon) || 0), 0) / Math.max(1, rows.length),
        averageReturnOnMarginPct: rows.reduce((sum, trade) => sum + (Number(trade.returnOnMarginPct) || 0), 0) / Math.max(1, rows.length)
      })).sort((a, b) => a.totalPnlMon - b.totalPnlMon);
    };
    const wins = pricedClosed.filter((trade) => Number(trade.pnlMon) > 0);
    const losses = pricedClosed.filter((trade) => Number(trade.pnlMon) < 0);
    return {
      count: pricedClosed.length,
      totalClosed: recentClosed.length,
      feeDataUnavailableCount,
      wins: wins.length,
      losses: losses.length,
      totalPnlMon: pricedClosed.reduce((sum, trade) => sum + (Number(trade.pnlMon) || 0), 0),
      averageWinMon: wins.reduce((sum, trade) => sum + Number(trade.pnlMon), 0) / Math.max(1, wins.length),
      averageLossMon: losses.reduce((sum, trade) => sum + Number(trade.pnlMon), 0) / Math.max(1, losses.length),
      bySymbol: group("symbol"),
      bySide: group("side"),
      byMode: group("mode"),
      byRegime: group("regime"),
      byCloseReason: group("closeReason"),
      worstTrades: pricedClosed.slice().sort((a, b) => Number(a.pnlMon) - Number(b.pnlMon)).slice(0, 15)
    };
  })() : null;`,
  "replace complete recentClosed mapping with bounded history and loss attribution",
);

source = once(source,
  '    if (path === "/paper/profits") {\n      try {\n        const summary = await getPaperSummary(this.state.storage, this.latest, Date.now(), this.lastTickAt);',
  '    if (path === "/paper/history") {\n      try {\n        const summary = await getPaperSummary(this.state.storage, this.latest, Date.now(), this.lastTickAt, true);\n        return json({ ok: true, ...summary });\n      } catch (error) {\n        const detail = String(error).slice(0, 500);\n        console.error("CIEL paper history DO route failed: " + detail);\n        return json({ ok: false, error: "PAPER_HISTORY_ROUTE_FAILED", detail }, 500);\n      }\n    }\n    if (path === "/paper/profits") {\n      try {\n        const summary = await getPaperSummary(this.state.storage, this.latest, Date.now(), this.lastTickAt);',
  "add dedicated paper history Durable Object route",
);

const apiAnchor = '    if (url.pathname === "/api/paper") {';
const apiRoute = `    if (url.pathname === "/api/paper/history") {
      try {
        const response = await feedStub2(env).fetch("https://feed/paper/history");
        const summary = await response.json().catch(() => ({}));
        if (!response.ok || summary.ok !== true) return json2({ ok: false, error: "Paper history unavailable", detail: summary.detail || summary.error || "Durable Object returned HTTP " + response.status }, 503);
        return json2({ ...summary, mode: "paper-only", readOnly: true });
      } catch (error) {
        return json2({ ok: false, error: "Paper history unavailable", detail: String(error).slice(0, 250) }, 503);
      }
    }
`;
const apiCount = source.split(apiAnchor).length - 1;
if (apiCount !== 1) throw new Error("paper history API route: expected one insertion point, found " + apiCount);
source = source.replace(apiAnchor, apiRoute + apiAnchor);

source = once(source,
  "openTrades, recentClosed, strategyStats",
  "openTrades, recentClosed, strategyStats, ...(includeHistory ? { historyAnalysis } : {})",
  "include aggregate paper history analysis in opt-in response",
);

await writeFile(file, source);
console.log("Added a read-only paper-history endpoint with bounded trade details and loss attribution.");
