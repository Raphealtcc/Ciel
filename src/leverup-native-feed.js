import { scoreTechnicalEvidence, isRecommendationScoreEligible } from "./technical-scoring.js";
import { fetchLeverUpPairs, fetchLatestOraclePrices } from "./leverup-readonly.js";

const SAMPLE_INTERVAL_MS = 60_000;
const MAX_SAMPLE_AGE_MS = 120_000;
const MIN_WARMUP_SAMPLES = 60;
const MAX_HISTORY_AGE_MS = 3 * 60 * 60 * 1000;

const upper = (value) => String(value || "").trim().toUpperCase();
const pairSymbol = (pair) => upper(pair?.symbol || String(pair?.pairName || pair?.name || "").split("/")[0]);
const pairBase = (pair) => String(pair?.base || pair?.pairBase || "").toLowerCase();
const eligiblePair = (pair) => {
  const base = pairBase(pair);
  const venue = upper(pair?.executionVenue || pair?.venue || "");
  const status = upper(pair?.status || "");
  return /^0x[0-9a-f]{40}$/.test(base) &&
    venue !== "HYPERLIQUID" &&
    !["INACTIVE", "DISABLED", "CLOSED", "DELISTED"].includes(status);
};

function ema(values, period) {
  if (!values.length) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, x) => sum + x, 0) / Math.min(period, values.length);
  for (let i = Math.min(period, values.length); i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    if (delta > 0) gains += delta;
    else losses -= delta;
  }
  if (losses === 0) return gains > 0 ? 100 : 50;
  return 100 - 100 / (1 + gains / losses);
}

function pctChange(values, periods) {
  if (values.length <= periods) return null;
  const from = values[values.length - 1 - periods], to = values.at(-1);
  return from > 0 ? (to / from - 1) * 100 : null;
}

export function evaluateLeverUpNativeSeries(symbol, rows, now = Date.now()) {
  const points = (rows || []).filter((row) =>
    Number.isFinite(Number(row.price)) && Number(row.price) > 0 &&
    Number.isFinite(Number(row.observed_at_ms)) &&
    now - Number(row.observed_at_ms) <= MAX_HISTORY_AGE_MS
  ).sort((a, b) => Number(a.observed_at_ms) - Number(b.observed_at_ms));
  const latest = points.at(-1);
  if (!latest || now - Number(latest.observed_at_ms) > MAX_SAMPLE_AGE_MS) {
    return { symbol, status: "STALE", samples: points.length, signal: null };
  }
  if (points.length < MIN_WARMUP_SAMPLES) {
    return { symbol, status: "WARMING_UP", samples: points.length, requiredSamples: MIN_WARMUP_SAMPLES, signal: null };
  }
  const recent = points.slice(-MIN_WARMUP_SAMPLES);
  const gaps = recent.slice(1).map((point, index) => Number(point.observed_at_ms) - Number(recent[index].observed_at_ms));
  const span = Number(recent.at(-1).observed_at_ms) - Number(recent[0].observed_at_ms);
  if (span < 55 * 60_000 || span > 75 * 60_000 || gaps.some((gap) => gap <= 0 || gap > 180_000)) {
    return { symbol, status: "GAPPED_HISTORY", samples: points.length, signal: null };
  }
  const prices = points.map((point) => Number(point.price));
  const fast = ema(prices, 9), slow = ema(prices, 21), strength = rsi(prices, 14);
  const m5 = pctChange(prices, 5), m15 = pctChange(prices, 15), h1 = pctChange(prices, 59);
  if (![fast, slow, strength, m5, m15, h1].every(Number.isFinite)) {
    return { symbol, status: "INSUFFICIENT_HISTORY", samples: points.length, signal: null };
  }
  const direction = fast > slow && m5 > 0 && m15 > 0 && h1 > 0 && strength >= 52 && strength <= 72
    ? "LONG"
    : fast < slow && m5 < 0 && m15 < 0 && h1 < 0 && strength >= 28 && strength <= 48
      ? "SHORT" : null;
  const recentPrices = prices.slice(-60);
  const minuteReturns = recentPrices.slice(1).map((value, index) => (value / recentPrices[index] - 1) * 100);
  const meanMinuteReturn = minuteReturns.length ? minuteReturns.reduce((sum, value) => sum + value, 0) / minuteReturns.length : 0;
  const momentumVolatilityPerMinutePct = minuteReturns.length > 1
    ? Math.sqrt(minuteReturns.reduce((sum, value) => sum + (value - meanMinuteReturn) ** 2, 0) / minuteReturns.length)
    : null;
  const technicalScore = direction ? scoreTechnicalEvidence({
    side: direction,
    trendAligned: direction === "LONG" ? fast > slow : fast < slow,
    momentumReturns: [m5, m15, h1],
    momentumVolatilityPerMinutePct,
    structureConfirmed: null,
    rsi: strength,
  }) : null;
  const signal = direction && isRecommendationScoreEligible(technicalScore.score) ? {
    symbol, side: direction, source: "LEVERUP_ORACLE_SAMPLES",
    score: technicalScore.score / 100,
    scoreDetails: technicalScore,
    price: Number(latest.price), observedAt: Number(latest.observed_at_ms),
    ema9: fast, ema21: slow, rsi14: strength,
    change5mPct: m5, change15mPct: m15, change1hPct: h1,
    evidence: ["ORACLE_PRICE_TREND", "MULTI_HORIZON_MOMENTUM", "RSI_CONFIRMATION"],
    unavailableEvidence: ["EXCHANGE_VOLUME", "ORDER_BOOK_DEPTH", "EXCHANGE_FUNDING"],
    executionEligible: false,
    reason: "Technical-only native-feed candidate. Full LeverUp preflight, portfolio checks and independent execution confirmation remain mandatory."
  } : null;
  return { symbol, status: signal ? "SIGNAL_CANDIDATE" : direction ? "INVALID_SCORE" : "NO_SIGNAL", samples: points.length, latestAt: Number(latest.observed_at_ms), signal, scoreFiltered: false, minimumTechnicalScore: 0 };
}

export async function runLeverUpNativeSampler({ env, now = Date.now(), dependencies = {} }) {
  if (!env?.HYPERLIQUID_FEED?.get || !env?.CIEL_STATE?.put) throw new Error("LEVERUP_NATIVE_FEED_BINDINGS_MISSING");
  const sampleAt = Math.floor(now / SAMPLE_INTERVAL_MS) * SAMPLE_INTERVAL_MS;
  const fetchImpl = dependencies.fetchImpl || fetch;
  const configuredWatch = String(env.WATCH_SYMBOLS || "BTC,ETH,MON,BNB,XRP,HYPE,ONDO,KPEPE,QNT,TRX,AAVE,ADA,CASHCAT,DOGE,LINK,LIT,PONS,PUMP,SEI,SOL,SUI,UNI,VIRTUAL,XMR").trim();
  let watchValues;
  try {
    const parsed = JSON.parse(configuredWatch);
    watchValues = Array.isArray(parsed) ? parsed : configuredWatch.split(",");
  } catch {
    watchValues = configuredWatch.split(",");
  }
  const watch = [...new Set(watchValues.map(upper).filter(Boolean))];
  const pairs = await (dependencies.fetchPairs || fetchLeverUpPairs)({ fetchImpl });
  const pairBySymbol = new Map();
  for (const pair of pairs || []) {
    const symbol = pairSymbol(pair);
    if (watch.includes(symbol) && eligiblePair(pair)) pairBySymbol.set(symbol, pair);
  }
  const selected = [...pairBySymbol.entries()];
  if (!selected.length) throw new Error("LEVERUP_NATIVE_FEED_NO_EXECUTABLE_WATCH_MARKETS");
  const bases = [...new Set(selected.map(([, pair]) => pairBase(pair)))];
  const prices = await (dependencies.fetchPrices || fetchLatestOraclePrices)(bases, { fetchImpl });
  const rows = [];
  for (const [symbol, pair] of selected) {
    const raw = prices[pairBase(pair)];
    if (raw == null || BigInt(raw) <= 0n) throw new Error("LEVERUP_NATIVE_ORACLE_PRICE_MISSING_" + symbol);
    const price = Number(raw) / 1e18;
    if (!Number.isFinite(price) || price <= 0) throw new Error("LEVERUP_NATIVE_ORACLE_PRICE_INVALID_" + symbol);
    rows.push({ symbol, pair_base: pairBase(pair), price, observed_at_ms: sampleAt });
  }
  const feed = env.HYPERLIQUID_FEED.get(env.HYPERLIQUID_FEED.idFromName("primary"));
  const storedResponse = await feed.fetch("https://feed/leverup/native-samples", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sampleAt, rows })
  });
  const stored = await storedResponse.json().catch(() => ({}));
  if (!storedResponse.ok || stored.ok !== true || !stored.samples) {
    throw new Error("LEVERUP_NATIVE_SAMPLE_STORAGE_FAILED: " + String(stored.error || storedResponse.status));
  }
  const symbols = selected.map(([symbol]) => symbol);
  const bySymbol = new Map(symbols.map((symbol) => [symbol, stored.samples[symbol] || []]));
  const markets = symbols.map((symbol) => evaluateLeverUpNativeSeries(symbol, bySymbol.get(symbol), now));
  const warmed = markets.filter((market) => market.status !== "WARMING_UP" && market.status !== "STALE" && market.status !== "INSUFFICIENT_HISTORY");
  const allReady = markets.length > 0 && markets.every((market) => market.status === "NO_SIGNAL" || market.status === "SIGNAL_CANDIDATE");
  const status = allReady ? "READY" : "WARMING_UP";
  const result = {
    status, sampledAt: sampleAt, observedAt: now, marketCount: markets.length,
    warmedMarkets: warmed.length, requiredSamples: MIN_WARMUP_SAMPLES,
    markets, candidates: markets.map((market) => market.signal).filter(Boolean),
    source: "LeverUp oracle prices and LeverUp-executable pair catalogue",
    unavailableEvidence: ["EXCHANGE_VOLUME", "ORDER_BOOK_DEPTH", "EXCHANGE_FUNDING"],
    executionEnabled: false
  };
  await env.CIEL_STATE.put("ciel:leverup:native-feed:status", status);
  await env.CIEL_STATE.put("ciel:leverup:native-feed:latest", JSON.stringify(result), { expirationTtl: 3600 });
  return result;
}
