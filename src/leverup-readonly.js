import {
  createPublicClient,
  defineChain,
  http,
} from "viem";
import { LEVERUP_1CT } from "./leverup-1ct.js";

export const LEVERUP_API = "https://service.leverup.xyz";
export const MIN_EXECUTION_LEVERAGE = 50;
export const MIN_NOTIONAL_SELECTOR = "0x3569c2f7";
export const PAIR_BY_BASE_SELECTOR = "0x9bd39764";

const monad = defineChain({
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.monad.xyz"] } },
});

const POSITION_V4_ABI = [{
  type: "function",
  name: "getPositionsV4",
  stateMutability: "view",
  inputs: [{ name: "user", type: "address" }, { name: "pairBase", type: "address" }],
  outputs: [{
    type: "tuple[]",
    name: "",
    components: [
      { name: "positionHash", type: "bytes32" },
      { name: "pair", type: "string" },
      { name: "pairBase", type: "address" },
      { name: "tokenIn", type: "address" },
      { name: "marginToken", type: "address" },
      { name: "isLong", type: "bool" },
      { name: "margin", type: "uint96" },
      { name: "qty", type: "uint128" },
      { name: "entryPrice", type: "uint128" },
      { name: "stopLoss", type: "uint128" },
      { name: "takeProfit", type: "uint128" },
      { name: "openFee", type: "uint96" },
      { name: "executionFee", type: "uint96" },
      { name: "fundingFee", type: "int256" },
      { name: "timestamp", type: "uint32" },
      { name: "holdingFee", type: "uint96" },
      { name: "earliestCloseTime", type: "uint256" },
      { name: "accruedFundingFee", type: "int256" },
      { name: "accruedHoldingFee", type: "uint256" },
    ],
  }],
}];

const MARKET_INFO_V2_ABI = [{
  type: "function",
  name: "getMarketInfoV2",
  stateMutability: "view",
  inputs: [{ name: "pairBase", type: "address" }],
  outputs: [{
    type: "tuple",
    name: "",
    components: [
      { name: "pairBase", type: "address" },
      { name: "longQty", type: "uint256" },
      { name: "shortQty", type: "uint256" },
      { name: "lpLongAvgPrice", type: "uint128" },
      { name: "lpShortAvgPrice", type: "uint128" },
      { name: "fundingFeeRate", type: "int256" },
      { name: "lastLongAccFundingFeePerShare", type: "int256" },
    ],
  }],
}];

function asWord(hex, byteOffset) {
  const start = 2 + byteOffset * 2;
  const word = hex.slice(start, start + 64);
  if (word.length !== 64) throw new Error("ABI word out of bounds at byte " + byteOffset);
  return BigInt("0x" + word);
}
function asSafeNumber(hex, byteOffset) {
  const value = asWord(hex, byteOffset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("ABI number exceeds safe integer");
  return Number(value);
}
function asAddress(hex, byteOffset) {
  const start = 2 + byteOffset * 2;
  const word = hex.slice(start, start + 64);
  if (word.length !== 64) throw new Error("ABI address out of bounds");
  return "0x" + word.slice(24);
}
function asString(hex, tupleBase, fieldWordIndex) {
  const offset = asSafeNumber(hex, tupleBase + fieldWordIndex * 32);
  const start = tupleBase + offset;
  const length = asSafeNumber(hex, start);
  const byteStart = 2 + (start + 32) * 2;
  const byteEnd = byteStart + length * 2;
  return BufferlessHex.decode(hex.slice(byteStart, byteEnd));
}
const BufferlessHex = {
  decode(hex) {
    let out = "";
    for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    try { return decodeURIComponent(escape(out)); } catch { return out; }
  },
};

export function decodePairView(result) {
  if (!result || result === "0x") throw new Error("getPairByBaseV4 returned empty data");
  const tupleBase = asSafeNumber(result, 0);
  const name = asString(result, tupleBase, 0);
  const base = asAddress(result, tupleBase + 32);
  const pairType = asSafeNumber(result, tupleBase + 3 * 32);
  const status = asSafeNumber(result, tupleBase + 4 * 32);
  const leverageOffset = asSafeNumber(result, tupleBase + 10 * 32);
  const leverageArrayBase = tupleBase + leverageOffset;
  const leverageCount = asSafeNumber(result, leverageArrayBase);
  const leverageMargins = [];
  for (let i = 0; i < leverageCount; i++) {
    const entry = leverageArrayBase + 32 + i * 5 * 32;
    leverageMargins.push({
      notionalUsdRaw: asWord(result, entry).toString(),
      tier: asSafeNumber(result, entry + 32),
      maxLeverage: asSafeNumber(result, entry + 64),
      initialLostPRaw: asWord(result, entry + 96).toString(),
      liqLostPRaw: asWord(result, entry + 128).toString(),
    });
  }
  const slippageBase = tupleBase + asSafeNumber(result, tupleBase + 13 * 32);
  const feeBase = tupleBase + asSafeNumber(result, tupleBase + 16 * 32);
  const feeConfig = {
    name: asString(result, feeBase, 0),
    index: asSafeNumber(result, feeBase + 32),
    openFeeP: asSafeNumber(result, feeBase + 64),
    closeFeeP: asSafeNumber(result, feeBase + 96),
    enabled: asSafeNumber(result, feeBase + 128) !== 0,
    shareP: asSafeNumber(result, feeBase + 160),
    minCloseFeeP: asSafeNumber(result, feeBase + 192),
  };
  const slippageConfig = {
    name: asString(result, slippageBase, 0),
    onePercentDepthAboveUsdRaw: asWord(result, slippageBase + 32).toString(),
    onePercentDepthBelowUsdRaw: asWord(result, slippageBase + 64).toString(),
    slippageLongP: asSafeNumber(result, slippageBase + 96),
    slippageShortP: asSafeNumber(result, slippageBase + 128),
    index: asSafeNumber(result, slippageBase + 160),
    slippageType: asSafeNumber(result, slippageBase + 192),
    enabled: asSafeNumber(result, slippageBase + 224) !== 0,
    longThresholdUsdRaw: asWord(result, slippageBase + 256).toString(),
    shortThresholdUsdRaw: asWord(result, slippageBase + 288).toString(),
  };
  return {
    name, base, pairType, status, leverageMargins, feeConfig, slippageConfig,
    maxLongOiUsdRaw: asWord(result, tupleBase + 5 * 32).toString(),
    maxShortOiUsdRaw: asWord(result, tupleBase + 6 * 32).toString(),
    fundingFeePerSecondPRaw: asWord(result, tupleBase + 7 * 32).toString(),
    minFundingFeeRRaw: asWord(result, tupleBase + 8 * 32).toString(),
    maxFundingFeeRRaw: asWord(result, tupleBase + 9 * 32).toString(),
    longHoldingFeeRateRaw: asWord(result, tupleBase + 17 * 32).toString(),
    shortHoldingFeeRateRaw: asWord(result, tupleBase + 18 * 32).toString(),
  };
}

async function fetchJson(url, init = {}, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    ...init,
    signal: init.signal || AbortSignal.timeout(12_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error("LeverUp HTTP " + response.status + " " + url + ": " + body.slice(0, 300));
  try { return JSON.parse(body); } catch { throw new Error("LeverUp returned invalid JSON from " + url); }
}

export function createLeverUpPublicClient(rpcUrl = "https://rpc.monad.xyz") {
  return createPublicClient({ chain: monad, transport: http(rpcUrl, { timeout: 12_000 }) });
}

export async function fetchLeverUpPairs({ fetchImpl = fetch, pageSize = 100 } = {}) {
  const data = await fetchJson(
    LEVERUP_API + "/v1/pairs?size=" + pageSize + "&block_chain=MONAD",
    {}, fetchImpl,
  );
  if (!Array.isArray(data?.content)) throw new Error("LeverUp pairs response is missing content[]");
  return data.content;
}

export async function fetchLatestOraclePrices(pairBases, { fetchImpl = fetch } = {}) {
  const unique = [...new Set((pairBases || []).map((x) => String(x).toLowerCase()))];
  if (!unique.length) throw new Error("pairBases must not be empty");
  const data = await fetchJson(LEVERUP_API + "/v1/oracle/price/pairs/latest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairBases: unique, blockChain: "MONAD" }),
  }, fetchImpl);
  if (!data?.prices || typeof data.prices !== "object") throw new Error("LeverUp oracle response is missing prices");
  if (Array.isArray(data.failures) && data.failures.length) {
    const failed = new Set(data.failures.map((x) => String(x.pairBase).toLowerCase()));
    for (const base of unique) if (failed.has(base)) throw new Error("LeverUp oracle unavailable for " + base);
  }
  return Object.fromEntries(unique.map((base) => {
    const raw = data.prices[base];
    if (raw == null || BigInt(raw) <= 0n) throw new Error("Missing/nonpositive LeverUp oracle price for " + base);
    return [base, BigInt(raw)];
  }));
}

export async function fetchOpenPositions(traderAddress, { fetchImpl = fetch } = {}) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(traderAddress || "")) throw new Error("Invalid trader address");
  const data = await fetchJson(
    LEVERUP_API + "/v1/user/" + traderAddress.toLowerCase() + "/open-positions?block_chain=MONAD&page=0&size=100",
    {}, fetchImpl,
  );
  if (!Array.isArray(data?.content)) throw new Error("Open positions response is missing content[]");
  return data.content;
}

export async function fetchAllPositions(traderAddress, { fetchImpl = fetch, page = 0, size = 100 } = {}) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(traderAddress || "")) throw new Error("Invalid trader address");
  const data = await fetchJson(
    LEVERUP_API + "/v1/user/" + traderAddress.toLowerCase() + "/positions?block_chain=MONAD&page=" + page + "&size=" + size,
    {}, fetchImpl,
  );
  if (!Array.isArray(data?.content)) throw new Error("Positions response is missing content[]");
  return data;
}

export async function fetchTradeHistory(traderAddress, { fetchImpl = fetch, page = 0, size = 100 } = {}) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(traderAddress || "")) throw new Error("Invalid trader address");
  const data = await fetchJson(
    LEVERUP_API + "/v1/user/" + traderAddress.toLowerCase() + "/trade/history?block_chain=MONAD&page=" + page + "&size=" + size,
    {}, fetchImpl,
  );
  if (!Array.isArray(data?.content)) throw new Error("Trade history response is missing content[]");
  return data;
}

export async function fetchAntiDdosConfig({ fetchImpl = fetch } = {}) {
  const data = await fetchJson(LEVERUP_1CT.baseUrl + "/v2/trading/anti-ddos-config", {}, fetchImpl);
  if (!Array.isArray(data)) throw new Error("1CT anti-DDOS config must be an array");
  return { fetchedAt: Date.now(), validUntil: Date.now() + 60_000, config: data };
}

export async function readPairByBaseV4(pairBase, { rpcUrl = "https://rpc.monad.xyz", fetchImpl = fetch } = {}) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(pairBase || "")) throw new Error("Invalid pairBase");
  const encodedAddress = pairBase.toLowerCase().slice(2).padStart(64, "0");
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: LEVERUP_1CT.diamond, data: PAIR_BY_BASE_SELECTOR + encodedAddress }, "latest"] }),
    signal: AbortSignal.timeout(12_000),
  });
  const data = await response.json();
  if (!response.ok || data.error || !data.result) throw new Error("getPairByBaseV4 failed: " + JSON.stringify(data.error || data).slice(0, 300));
  return decodePairView(data.result);
}

export async function readGlobalMinimumNotional({ rpcUrl = "https://rpc.monad.xyz", fetchImpl = fetch } = {}) {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_call", params: [{ to: LEVERUP_1CT.diamond, data: MIN_NOTIONAL_SELECTOR }, "latest"] }),
    signal: AbortSignal.timeout(12_000),
  });
  const data = await response.json();
  if (!response.ok || data.error || !data.result || data.result.length < 130) throw new Error("getTradingConfig failed: " + JSON.stringify(data.error || data).slice(0, 300));
  return asWord(data.result, 32);
}

export async function readMarketInfoV2(pairBase, { publicClient = createLeverUpPublicClient() } = {}) {
  return publicClient.readContract({
    address: LEVERUP_1CT.diamond,
    abi: MARKET_INFO_V2_ABI,
    functionName: "getMarketInfoV2",
    args: [pairBase],
  });
}

export async function readPositionsV4(traderAddress, pairBase, { publicClient = createLeverUpPublicClient() } = {}) {
  return publicClient.readContract({
    address: LEVERUP_1CT.diamond,
    abi: POSITION_V4_ABI,
    functionName: "getPositionsV4",
    args: [traderAddress, pairBase],
  });
}

export function selectLeverageTier(leverageMargins, notionalUsd) {
  const notional = typeof notionalUsd === "bigint" ? notionalUsd : BigInt(notionalUsd);
  const tiers = [...(leverageMargins || [])]
    .filter((tier) => BigInt(tier.notionalUsdRaw) > 0n)
    .sort((a, b) => BigInt(a.notionalUsdRaw) < BigInt(b.notionalUsdRaw) ? -1 : 1);
  return tiers.find((tier) => notional <= BigInt(tier.notionalUsdRaw)) || null;
}

export function assertMinimumLeverage({
  requestedLeverage, marketMaxLeverage, leverageMargins, notionalUsd,
}) {
  const requested = Number(requestedLeverage);
  if (!Number.isFinite(requested) || requested < MIN_EXECUTION_LEVERAGE) {
    throw new Error("LEVERAGE_BELOW_50X: CIEL may not open below 50x");
  }
  if (!Number.isFinite(Number(marketMaxLeverage)) || Number(marketMaxLeverage) < MIN_EXECUTION_LEVERAGE) {
    throw new Error("MARKET_MAX_LEVERAGE_BELOW_50X: market is not eligible");
  }
  const tier = selectLeverageTier(leverageMargins, notionalUsd);
  if (!tier) throw new Error("NO_LEVERAGE_TIER_FOR_NOTIONAL");
  if (Number(tier.maxLeverage) < MIN_EXECUTION_LEVERAGE) {
    throw new Error("NOTIONAL_TIER_MAX_BELOW_50X");
  }
  if (requested > Number(tier.maxLeverage)) {
    throw new Error("REQUESTED_LEVERAGE_EXCEEDS_NOTIONAL_TIER_MAX");
  }
  if (requested > Number(marketMaxLeverage)) {
    throw new Error("REQUESTED_LEVERAGE_EXCEEDS_MARKET_MAX");
  }
  return { requestedLeverage: requested, tierMaxLeverage: Number(tier.maxLeverage), tier };
}

export function calculateMinimumCollateralMon({
  minimumNotionalUsd, leverage, monUsdPrice, collateralRatio,
}) {
  const minNotional = Number(minimumNotionalUsd);
  const lev = Number(leverage);
  const price = Number(monUsdPrice);
  const ratio = Number(collateralRatio);
  if (![minNotional, lev, price, ratio].every(Number.isFinite) ||
      minNotional <= 0 || lev < MIN_EXECUTION_LEVERAGE || price <= 0 || ratio <= 0 || ratio > 1) {
    throw new Error("MINIMUM_COLLATERAL_INPUTS_INVALID_OR_UNVERIFIED");
  }
  return minNotional / (lev * price * ratio);
}

export function assertMarginBudget({
  availableMarginMon, requiredMinimumMon, reserveMon = 0, safetyBufferPct = 5,
}) {
  const available = Number(availableMarginMon);
  const required = Number(requiredMinimumMon);
  const reserve = Number(reserveMon);
  const buffer = Number(safetyBufferPct);
  if (![available, required, reserve, buffer].every(Number.isFinite) ||
      available < 0 || required <= 0 || reserve < 0 || buffer < 0 || buffer > 100) {
    throw new Error("MARGIN_BUDGET_INPUTS_INVALID");
  }
  const requiredWithBuffer = required * (1 + buffer / 100) + reserve;
  if (available < requiredWithBuffer) {
    throw new Error("INSUFFICIENT_MARGIN_FOR_VENUE_MINIMUM: need " + requiredWithBuffer.toFixed(4) + " MON");
  }
  return { availableMarginMon: available, requiredMinimumMon: required, requiredWithBufferMon: requiredWithBuffer };
}

export function buildLeverUpPreflight({
  market, pairView, oraclePriceRaw, monUsdPriceRaw, minimumNotionalRaw,
  requestedLeverage, availableMarginMon, collateralRatio, reserveMon = 0,
  safetyBufferPct = 5, now = Date.now(),
}) {
  if (!market || market.status !== "AVAILABLE") throw new Error("MARKET_NOT_AVAILABLE");
  if (market.executionVenue && market.executionVenue !== "LEVERUP") throw new Error("MARKET_NOT_EXECUTED_BY_LEVERUP");
  if (!pairView?.leverageMargins?.length) throw new Error("LIVE_LEVERAGE_TIERS_MISSING");
  if (!oraclePriceRaw || BigInt(oraclePriceRaw) <= 0n) throw new Error("LEVERUP_ORACLE_PRICE_MISSING");
  if (!monUsdPriceRaw || BigInt(monUsdPriceRaw) <= 0n) throw new Error("LEVERUP_MON_ORACLE_PRICE_MISSING");
  if (minimumNotionalRaw == null || BigInt(minimumNotionalRaw) <= 0n) throw new Error("GLOBAL_MIN_NOTIONAL_MISSING");
  if (market.minHoldingSeconds == null) throw new Error("MIN_HOLDING_REQUIREMENT_MISSING");

  const notionalUsd = Number(minimumNotionalRaw) / 1e18;
  const marketMaxLeverage = Math.max(...pairView.leverageMargins.map((x) => Number(x.maxLeverage)));
  const leverage = assertMinimumLeverage({
    requestedLeverage, marketMaxLeverage,
    leverageMargins: pairView.leverageMargins, notionalUsd: BigInt(minimumNotionalRaw),
  });
  const minimumCollateralMon = calculateMinimumCollateralMon({
    minimumNotionalUsd: notionalUsd,
    leverage: leverage.requestedLeverage,
    monUsdPrice: Number(monUsdPriceRaw) / 1e18,
    collateralRatio,
  });
  const margin = assertMarginBudget({
    availableMarginMon, requiredMinimumMon: minimumCollateralMon, reserveMon, safetyBufferPct,
  });
  return {
    checkedAt: now,
    chainId: 143,
    pair: market.pairName,
    pairBase: market.base.toLowerCase(),
    status: market.status,
    maxLeverageForNotional: leverage.tierMaxLeverage,
    requestedLeverage: leverage.requestedLeverage,
    minHoldingSeconds: Number(market.minHoldingSeconds),
    oraclePriceUsd: Number(oraclePriceRaw) / 1e18,
    monUsdPrice: Number(monUsdPriceRaw) / 1e18,
    minimumNotionalUsd: notionalUsd,
    collateralRatio,
    minimumCollateralMon,
    marginBudget: margin,
    protocolFeeConfig: pairView.feeConfig,
    slippageConfig: pairView.slippageConfig,
    fundingFeePerSecondPRaw: pairView.fundingFeePerSecondPRaw,
    longHoldingFeeRateRaw: pairView.longHoldingFeeRateRaw,
    shortHoldingFeeRateRaw: pairView.shortHoldingFeeRateRaw,
    estimatedCarryCosts: null,
    estimatedProtocolFees: null,
    estimationNote: "Raw live rates are captured. Holding/funding and fee-base formulas are not estimated here; use actual position accruals and closed settlement records to validate them.",
  };
}

export function normalizePositionAccrual(position) {
  return {
    positionHash: position.positionHash,
    pair: position.pair,
    pairBase: position.pairBase,
    isLong: Boolean(position.isLong),
    marginToken: position.marginToken,
    marginRaw: String(position.margin),
    openFeeRaw: String(position.openFee),
    executionFeeRaw: String(position.executionFee),
    fundingFeeRaw: String(position.fundingFee),
    holdingFeeRaw: String(position.holdingFee),
    accruedFundingFeeRaw: String(position.accruedFundingFee),
    accruedHoldingFeeRaw: String(position.accruedHoldingFee),
    earliestCloseTime: String(position.earliestCloseTime),
    timestamp: Number(position.timestamp),
    observedAt: Date.now(),
  };
}

export function reconcileClosedPosition(closedPosition, lastLiveSnapshot = null) {
  if (closedPosition?.status !== "CLOSED" || !closedPosition.closeInfo) {
    throw new Error("POSITION_NOT_SETTLED");
  }
  const close = closedPosition.closeInfo;
  const asBigInt = (value, name) => {
    if (value == null) throw new Error("SETTLEMENT_FIELD_MISSING: " + name);
    return BigInt(value);
  };
  const openFee = asBigInt(closedPosition.openFee, "openFee");
  const closeFee = asBigInt(close.closeFee, "closeFee");
  const fundingFee = asBigInt(close.fundingFee, "fundingFee");
  const holdingFee = asBigInt(close.holdingFee, "holdingFee");
  const pnl = asBigInt(close.pnl, "pnl");
  const totalTradingFees = openFee + closeFee;
  const netCarryCost = holdingFee - fundingFee;
  const totalNetCosts = totalTradingFees + netCarryCost;
  return {
    positionHash: closedPosition.positionHash,
    pair: closedPosition.pair,
    status: closedPosition.status,
    closeTime: Number(close.closeTime),
    closePriceRaw: String(close.closePrice),
    grossPnlRaw: pnl.toString(),
    openFeeRaw: openFee.toString(),
    closeFeeRaw: closeFee.toString(),
    fundingFeeRaw: fundingFee.toString(),
    holdingFeeRaw: holdingFee.toString(),
    totalTradingFeesRaw: totalTradingFees.toString(),
    netCarryCostRaw: netCarryCost.toString(),
    totalNetCostsRaw: totalNetCosts.toString(),
    netPnlAfterFeesRaw: (pnl - totalNetCosts).toString(),
    lastObservedFundingFeeRaw: lastLiveSnapshot?.fundingFeeRaw ?? null,
    lastObservedHoldingFeeRaw: lastLiveSnapshot?.holdingFeeRaw ?? null,
    fundingSinceLastSnapshotRaw: lastLiveSnapshot
      ? (fundingFee - BigInt(lastLiveSnapshot.fundingFeeRaw)).toString() : null,
    holdingSinceLastSnapshotRaw: lastLiveSnapshot
      ? (holdingFee - BigInt(lastLiveSnapshot.holdingFeeRaw)).toString() : null,
    reconciledAt: Date.now(),
  };
}

export async function readLeverUpAccountSnapshot({
  traderAddress, symbol, collateralRatio, rpcUrl = "https://rpc.monad.xyz",
  fetchImpl = fetch, publicClient = createLeverUpPublicClient(rpcUrl),
}) {
  const [pairs, antiDdos] = await Promise.all([
    fetchLeverUpPairs({ fetchImpl }),
    fetchAntiDdosConfig({ fetchImpl }),
  ]);
  const market = pairs.find((item) => item.symbol === symbol || item.pairName === symbol + "/USD");
  if (!market) throw new Error("LEVERUP_MARKET_NOT_FOUND: " + symbol);
  const pairBase = market.base || market.pairBase;
  if (!pairBase) throw new Error("LEVERUP_PAIR_BASE_MISSING");
  const monMarket = pairs.find((item) => item.symbol === "MON" || item.pairName === "MON/USD");
  if (!monMarket?.base) throw new Error("MON_COLLATERAL_PRICE_PAIR_MISSING");
  const [prices, pairView, minimumNotionalRaw, marketInfo, indexedPositions, onchainPositions] = await Promise.all([
    fetchLatestOraclePrices([pairBase, monMarket.base], { fetchImpl }),
    readPairByBaseV4(pairBase, { rpcUrl, fetchImpl }),
    readGlobalMinimumNotional({ rpcUrl, fetchImpl }),
    readMarketInfoV2(pairBase, { publicClient }),
    traderAddress ? fetchOpenPositions(traderAddress, { fetchImpl }) : Promise.resolve([]),
    traderAddress ? readPositionsV4(traderAddress, pairBase, { publicClient }) : Promise.resolve([]),
  ]);
  return {
    checkedAt: Date.now(),
    market,
    pairView,
    oraclePriceRaw: prices[pairBase.toLowerCase()].toString(),
    monUsdPriceRaw: prices[monMarket.base.toLowerCase()].toString(),
    minimumNotionalRaw: minimumNotionalRaw.toString(),
    marketInfo: {
      longQty: String(marketInfo.longQty),
      shortQty: String(marketInfo.shortQty),
      fundingFeeRate: String(marketInfo.fundingFeeRate),
      lastLongAccFundingFeePerShare: String(marketInfo.lastLongAccFundingFeePerShare),
    },
    indexedPositions,
    onchainPositions: onchainPositions.map(normalizePositionAccrual),
    antiDdosConfig: antiDdos,
    collateralRatio: collateralRatio ?? null,
  };
}
