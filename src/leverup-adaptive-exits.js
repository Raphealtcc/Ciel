import { evaluateAdaptiveMarketPosition } from "./adaptive-market-position.js";

const adaptiveLeverUpRawToPrice = (value) => {
  try { const raw = BigInt(value || 0); return raw > 0n ? Number(raw) / 1e18 : 0; }
  catch { return 0; }
};
const adaptiveLeverUpPriceToRaw = (value) => {
  const price = Number(value);
  if (!Number.isFinite(price) || price <= 0) return "0";
  return BigInt(Math.max(1, Math.round(price * 1e18))).toString();
};

export function evaluateAdaptiveLeverUpExit({ position, currentPriceRaw, state = {}, pairView = {}, now = Date.now(), sampleLimit = 24 }) {
  if (!position?.positionHash || !position?.entryPriceRaw || !currentPriceRaw) {
    return { action: "HOLD", reason: "ADAPTIVE_INPUT_INCOMPLETE", state };
  }
  const depthAbove = Number(pairView?.slippageConfig?.onePercentDepthAboveUsdRaw || 0);
  const depthBelow = Number(pairView?.slippageConfig?.onePercentDepthBelowUsdRaw || 0);
  const shallowSide = position.isLong ? depthBelow : depthAbove;
  const deepSide = position.isLong ? depthAbove : depthBelow;
  const result = evaluateAdaptiveMarketPosition({
    side: position.isLong ? "LONG" : "SHORT",
    entryPrice: adaptiveLeverUpRawToPrice(position.entryPriceRaw),
    currentPrice: adaptiveLeverUpRawToPrice(currentPriceRaw),
    stopPrice: adaptiveLeverUpRawToPrice(position.stopLossRaw),
    targetPrice: adaptiveLeverUpRawToPrice(position.takeProfitRaw),
    state, now,
    liquidityImbalance: shallowSide > 0 && deepSide > 0 && shallowSide / deepSide < 0.35,
    sampleLimit: Math.max(8, Math.min(24, Number(sampleLimit) || 24)),
  });
  const shared = {
    reason: result.reason,
    reverseConfirmed: result.reverseConfirmed === true,
    trendPct: result.trendPct ?? null,
    momentumPct: result.momentumPct ?? null,
    atrProxyPct: result.atrProxyPct ?? null,
    closeScore: result.closeScore ?? null,
    favourablePct: result.favourablePct ?? null,
    peakFavourablePct: result.peakFavourablePct ?? null,
    givebackPct: result.givebackPct ?? null,
    samples: result.state?.history?.length ?? 0,
    state: result.state || state,
  };
  if (result.action === "CLOSE") return { action: "MARKET_CLOSE", ...shared };
  if (result.action === "UPDATE_LEVELS") return {
    action: "UPDATE_TP_SL", ...shared,
    stopLossRaw: adaptiveLeverUpPriceToRaw(result.stopPrice ?? adaptiveLeverUpRawToPrice(position.stopLossRaw)),
    takeProfitRaw: adaptiveLeverUpPriceToRaw(result.targetPrice ?? adaptiveLeverUpRawToPrice(position.takeProfitRaw)),
    targetExtended: result.targetExtended === true,
  };
  return { action: "HOLD", ...shared };
}
