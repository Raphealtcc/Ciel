const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function pointAtOrBefore(points, target, toleranceMs) {
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i];
    const ts = Number(point?.t ?? point?.ts_ms);
    const price = Number(point?.p ?? point?.mid_price);
    if (!Number.isFinite(ts) || !Number.isFinite(price) || price <= 0 || ts > target) continue;
    return target - ts <= toleranceMs ? { ts, price } : null;
  }
  return null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Cross-sectional advance/decline breadth from the existing in-memory price
 * history. It deliberately excludes the candidate asset and never writes D1.
 */
export function calculateCrossAssetBreadth({ history = {}, symbols = [], excludeSymbol = "", volumeBySymbol = null, minimumVolumeUsd = 250000, now = Date.now() }) {
  const excluded = String(excludeSymbol).toUpperCase();
  const returns5 = [], returns15 = [];
  const unique = [...new Set((Array.isArray(symbols) ? symbols : []).map((s) => String(s).toUpperCase()))]
    .filter((s) => s && s !== excluded && s !== "MON");
  for (const symbol of unique) {
    if (volumeBySymbol && !(Number(volumeBySymbol[symbol]) >= minimumVolumeUsd)) continue;
    const points = Array.isArray(history?.[symbol]) ? history[symbol] : [];
    if (points.length < 3) continue;
    const latest = pointAtOrBefore(points, now, 120000);
    const base5 = pointAtOrBefore(points, now - 5 * 60000, 120000);
    const base15 = pointAtOrBefore(points, now - 15 * 60000, 150000);
    if (!latest || !base5 || !base15) continue;
    returns5.push((latest.price / base5.price - 1) * 100);
    returns15.push((latest.price / base15.price - 1) * 100);
  }
  const n5 = returns5.length, n15 = returns15.length;
  const ready = n5 >= 8 && n15 >= 8;
  const up5Pct = n5 ? returns5.filter((r) => r > 0).length / n5 * 100 : null;
  const up15Pct = n15 ? returns15.filter((r) => r > 0).length / n15 * 100 : null;
  return {
    status: ready ? "READY" : "INSUFFICIENT_COVERAGE",
    asOf: now,
    n5,
    n15,
    up5Pct,
    up15Pct,
    medianReturn5mPct: median(returns5),
    medianReturn15mPct: median(returns15),
    universeSize: unique.length,
    excludedSymbol: excluded || null,
    methodology: "equal-weight advance/decline breadth; candidate excluded; 5m and 15m sampled returns",
  };
}

function pruneEvents(events, cutoff, maxItems) {
  return (Array.isArray(events) ? events : []).filter((event) => Number(event?.t) >= cutoff).slice(-maxItems);
}

/**
 * Cont-Kukanov-Stoikov best-quote OFI event from consecutive L2 snapshots.
 * This is a research feature, not a standalone trade trigger.
 */
export function appendBookFlowSnapshot(previous = {}, snapshot, now = Date.now()) {
  const bid = finite(snapshot?.best_bid), ask = finite(snapshot?.best_ask);
  const bidSize = finite(snapshot?.bid_size), askSize = finite(snapshot?.ask_size);
  if (!(bid > 0 && ask > bid && bidSize >= 0 && askSize >= 0)) return previous || {};
  const next = { ...(previous || {}) };
  const prior = next.lastBook;
  next.lastBook = { t: Number(snapshot?.ts_ms) || now, bid, ask, bidSize, askSize };
  next.lastBookAt = Number(snapshot?.ts_ms) || now;
  next.bookEvents = pruneEvents(next.bookEvents, now - 60000, 240);
  if (prior && now - Number(prior.t) >= 0 && now - Number(prior.t) <= 5000) {
    const bidFlow = bid > prior.bid ? bidSize : bid === prior.bid ? bidSize - prior.bidSize : -prior.bidSize;
    const askFlow = ask < prior.ask ? -askSize : ask === prior.ask ? prior.askSize - askSize : prior.askSize;
    const ofi = bidFlow + askFlow;
    const liquidity = Math.max(1e-12, (prior.bidSize + prior.askSize + bidSize + askSize) / 2);
    next.bookEvents.push({ t: Number(snapshot?.ts_ms) || now, ofi, liquidity });
  }
  next.bookEvents = pruneEvents(next.bookEvents, now - 60000, 240);
  return next;
}

export function appendTradeFlowEvents(previous = {}, trades, now = Date.now()) {
  const next = { ...(previous || {}) };
  next.tradeEvents = pruneEvents(next.tradeEvents, now - 60000, 500);
  const updates = Array.isArray(trades) ? trades : [trades];
  const seen = new Set((next.tradeEvents || []).map((event) => event.key));
  for (const trade of updates) {
    if (!trade || typeof trade !== "object") continue;
    const price = finite(trade.px), size = finite(trade.sz);
    const ts = finite(trade.time) || now;
    const side = String(trade.side || "").toUpperCase();
    if (!(price > 0 && size > 0) || !["B", "A", "BUY", "SELL"].includes(side)) continue;
    const key = String(trade.tid ?? trade.hash ?? "") + ":" + ts;
    if (seen.has(key)) continue;
    seen.add(key);
    const notional = price * size;
    const signed = side === "B" || side === "BUY" ? notional : -notional;
    next.tradeEvents.push({ t: ts, signed, notional, key });
  }
  next.tradeEvents = pruneEvents(next.tradeEvents, now - 60000, 500);
  next.lastTradeAt = Math.max(Number(next.lastTradeAt) || 0, ...next.tradeEvents.map((event) => Number(event.t) || 0));
  return next;
}

/**
 * Requires sustained agreement across multiple 10-second buckets, book OFI,
 * and signed trade notional. Missing/stale observations remain unavailable.
 */
export function summarizePersistentOrderFlow(record = null, now = Date.now()) {
  const book = pruneEvents(record?.bookEvents, now - 30000, 240);
  const trades = pruneEvents(record?.tradeEvents, now - 30000, 500);
  const lastBookAt = Number(record?.lastBookAt || 0);
  const stale = !record || !lastBookAt || now - lastBookAt > 15000 || now < lastBookAt;
  const ofi = book.reduce((sum, event) => sum + Number(event.ofi || 0), 0);
  const liquidity = book.reduce((sum, event) => sum + Number(event.liquidity || 0), 0);
  const bookImbalance = liquidity > 0 ? ofi / liquidity : null;
  const signedTrade = trades.reduce((sum, event) => sum + Number(event.signed || 0), 0);
  const totalTrade = trades.reduce((sum, event) => sum + Number(event.notional || 0), 0);
  const tradeImbalance = totalTrade > 0 ? signedTrade / totalTrade : null;
  const bins = [0, 1, 2].map((index) => book.filter((event) => {
    const age = now - Number(event.t);
    return age >= index * 10000 && age < (index + 1) * 10000;
  }));
  const activeBins = bins.filter((items) => items.length > 0);
  const direction = bookImbalance > 0 ? "LONG" : bookImbalance < 0 ? "SHORT" : null;
  const agreeingBins = direction ? activeBins.filter((items) => {
    const total = items.reduce((sum, event) => sum + Number(event.ofi || 0), 0);
    return direction === "LONG" ? total > 0 : total < 0;
  }).length : 0;
  const persistence = activeBins.length ? agreeingBins / activeBins.length : 0;
  const signsAgree = direction && tradeImbalance !== null &&
    (direction === "LONG" ? tradeImbalance > 0 : tradeImbalance < 0);
  const sufficient = book.length >= 8 && trades.length >= 5 && activeBins.length >= 2;
  const persistent = !stale && sufficient && Math.abs(bookImbalance || 0) >= 0.08 &&
    Math.abs(tradeImbalance || 0) >= 0.05 && persistence >= 0.67 && signsAgree;
  return {
    status: !record ? "UNAVAILABLE" : stale ? "STALE" : !sufficient ? "INSUFFICIENT" : persistent ? "PERSISTENT" : "MIXED",
    direction: persistent ? direction : null,
    asOf: lastBookAt || null,
    bookEvents: book.length,
    tradeCount: trades.length,
    active10sBuckets: activeBins.length,
    bucketAgreement: Number(persistence.toFixed(3)),
    bookImbalance: bookImbalance === null ? null : Number(clamp(bookImbalance, -1, 1).toFixed(4)),
    tradeImbalance: tradeImbalance === null ? null : Number(clamp(tradeImbalance, -1, 1).toFixed(4)),
    methodology: "30s rolling top-quote OFI + signed trade notional; >=8 book events, >=5 trades, >=2 active 10s buckets",
  };
}
