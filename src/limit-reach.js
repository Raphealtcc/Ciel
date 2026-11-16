const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function normalizeCandles(rows, now) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    openAt: Number(row?.open_ts_ms),
    closeAt: Number(row?.close_ts_ms),
    open: Number(row?.open_price),
    high: Number(row?.high_price),
    low: Number(row?.low_price),
    close: Number(row?.close_price),
    volume: Number(row?.volume) || 0,
  })).filter((c) => c.openAt > 0 && c.closeAt > 0 && c.closeAt <= now &&
    [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v) && v > 0) &&
    c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close))
    .sort((a, b) => a.closeAt - b.closeAt);
}

function clusterPivots(pivots, tolerance) {
  const groups = [];
  for (const pivot of pivots) {
    let group = groups.find((item) => Math.abs(pivot.price / item.level - 1) <= tolerance);
    if (!group) {
      groups.push({ level: pivot.price, touches: 1, lastIndex: pivot.index, firstIndex: pivot.index });
      continue;
    }
    if (pivot.index - group.lastIndex < 3) continue;
    group.level = (group.level * group.touches + pivot.price) / (group.touches + 1);
    group.touches += 1;
    group.lastIndex = pivot.index;
  }
  return groups.filter((group) => group.touches >= 2);
}

/**
 * Limit Reach is an independent, bounded range-reversal candidate generator.
 * It consumes only the already-cached, closed 5m candle buffer. It performs no
 * network or D1 reads and never gates or vetoes other strategy candidates.
 */
export function analyzeLimitReach(symbol, rows, now = Date.now()) {
  const candles = normalizeCandles(rows, Number(now)).slice(-288);
  if (candles.length < 60) return null;

  const last = candles[candles.length - 1];
  if (Number(now) - last.closeAt > 7 * 60_000 || last.closeAt > Number(now) + 15_000) return null;

  const pivotHighs = [], pivotLows = [];
  for (let i = 2; i < candles.length - 2; i++) {
    const current = candles[i];
    if (current.high >= candles[i - 1].high && current.high >= candles[i - 2].high &&
        current.high > candles[i + 1].high && current.high > candles[i + 2].high) {
      pivotHighs.push({ index: i, price: current.high });
    }
    if (current.low <= candles[i - 1].low && current.low <= candles[i - 2].low &&
        current.low < candles[i + 1].low && current.low < candles[i + 2].low) {
      pivotLows.push({ index: i, price: current.low });
    }
  }

  const tr = [];
  for (let i = Math.max(1, candles.length - 15); i < candles.length; i++) {
    const c = candles[i], previousClose = candles[i - 1].close;
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - previousClose), Math.abs(c.low - previousClose)));
  }
  const atr = tr.reduce((sum, value) => sum + value, 0) / Math.max(1, tr.length);
  if (!(atr > 0 && last.close > 0)) return null;
  const tolerance = clamp((atr / last.close) * 0.25, 0.0008, 0.0020);
  const highs = clusterPivots(pivotHighs, tolerance);
  const lows = clusterPivots(pivotLows, tolerance);
  if (!highs.length || !lows.length) return null;

  const high = highs.filter((g) => g.level > last.close &&
    (g.level / last.close - 1) <= 0.03)
    .sort((a, b) => Math.abs(last.close / a.level - 1) - Math.abs(last.close / b.level - 1))[0];
  const low = lows.filter((g) => g.level < last.close &&
    (last.close / g.level - 1) <= 0.03)
    .sort((a, b) => Math.abs(last.close / a.level - 1) - Math.abs(last.close / b.level - 1))[0];
  if (!high || !low || !(high.level > low.level)) return null;

  const recent = candles.slice(-3);
  const recentHigh = Math.max(...recent.map((c) => c.high));
  const recentLow = Math.min(...recent.map((c) => c.low));
  const body = Math.abs(last.close - last.open);
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const rejectionDistance = 0.0035;
  let side = null, targetLevel = 0, stopPct = 0, targetPct = 0, touchCount = 0, level = 0;

  if (Math.abs(last.close / high?.level - 1) <= 0.004 && last.close < last.open && upperWick >= Math.max(body * 0.35, last.close * 0.0002) &&
      Math.abs(recentHigh / high.level - 1) <= rejectionDistance && last.close < high.level &&
      low.level < last.close) {
    side = "SHORT";
    level = high.level;
    targetLevel = low.level;
    touchCount = high.touches + low.touches;
    const stopPrice = high.level + Math.max(atr * 0.45, last.close * 0.0008);
    stopPct = Math.max(0.12, (stopPrice / last.close - 1) * 100);
    targetPct = (last.close / targetLevel - 1) * 100;
  } else if (Math.abs(last.close / low?.level - 1) <= 0.004 && last.close > last.open && lowerWick >= Math.max(body * 0.35, last.close * 0.0002) &&
      Math.abs(recentLow / low.level - 1) <= rejectionDistance && last.close > low.level &&
      high.level > last.close) {
    side = "LONG";
    level = low.level;
    targetLevel = high.level;
    touchCount = high.touches + low.touches;
    const stopPrice = low.level - Math.max(atr * 0.45, last.close * 0.0008);
    stopPct = Math.max(0.12, (1 - stopPrice / last.close) * 100);
    targetPct = (targetLevel / last.close - 1) * 100;
  }
  if (!side || !(stopPct > 0 && stopPct <= 0.45 && targetPct >= stopPct * 1.35 && targetPct <= 3.0)) return null;

  const confidence = Math.min(0.88, 0.78 + Math.min(0.06, Math.max(0, touchCount - 4) * 0.01) + 0.02);
  return {
    symbol: String(symbol || "").toUpperCase(),
    side,
    entry: last.close,
    stopPct,
    targetPct,
    confidence,
    scoreComponents: [
      "LIMIT_REACH_HIGH_REPEATED_TOUCHES",
      "LIMIT_REACH_LOW_REPEATED_TOUCHES",
      "LIMIT_REACH_REJECTION",
      "LIMIT_REACH_OPPOSITE_ZONE_TARGET",
    ],
    scoreModel: "limit-reach-repeated-range-levels-v1",
    strategy: "LIMIT_REACH_RANGE_REVERSAL",
    regime: "COUNTER_TREND_REVERSAL",
    mode: "TREND_HOLD",
    holdMinutes: 180,
    rsi: null,
    bounce: null,
    cci: null,
    stochRsi: null,
    rangePositionPct: null,
    targetZonePrice: targetLevel,
    repeatedTouches: { high: high.touches, low: low.touches },
    reason: "Limit Reach detected " + high.touches + " repeated high touches near " +
      high.level.toPrecision(8) + " and " + low.touches + " repeated low touches near " +
      low.level.toPrecision(8) + "; a closed 5m rejection candle supports " + side +
      " toward the opposite range zone. Levels are historical reference zones, not guaranteed turning points.",
  };
}
