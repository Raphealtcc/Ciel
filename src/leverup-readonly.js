import {
  createPublicClient,
  defineChain,
  http,
  hexToString,
} from "viem";
import { LEVERUP_1CT } from "./leverup-1ct.js";

export const LEVERUP_API = "https://service.leverup.xyz";
export const MIN_EXECUTION_LEVERAGE = 50;
export const LEVERUP_TOKENS = Object.freeze({
  WMON: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A",
  LVMON: "0x91b81bfbe3A747230F0529Aa28d8b2Bc898E6D56",
  USDC: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
  LVUSD: "0xFD44B35139Ae53FFF7d8F2A9869c503D987f00d1",
});
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
  return hexToString("0x" + hex.slice(byteStart, byteEnd));
}

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
    fundingFeeConfigRaw: asWord(result, tupleBase + 7 * 32).toString(),
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

export async function fetchAllPositionsPaginated(traderAddress, { fetchImpl = fetch, size = 100, maxPages = 100 } = {}) {
  const all = [];
  let totalPages = 1;
  for (let page = 0; page < Math.min(totalPages, maxPages); page++) {
    const result = await fetchAllPositions(traderAddress, { fetchImpl, page, size });
    all.push(...result.content);
    totalPages = Number(result.totalPages || 1);
  }
  if (totalPages > maxPages) throw new Error("POSITION_HISTORY_PAGE_LIMIT_EXCEEDED");
  return all;
}

export async function fetchAllTradeHistoryPaginated(traderAddress, { fetchImpl = fetch, size = 100, maxPages = 100 } = {}) {
  const all = [];
  let totalPages = 1;
  for (let page = 0; page < Math.min(totalPages, maxPages); page++) {
    const result = await fetchTradeHistory(traderAddress, { fetchImpl, page, size });
    all.push(...result.content);
    totalPages = Number(result.totalPages || 1);
  }
  if (totalPages > maxPages) throw new Error("TRADE_HISTORY_PAGE_LIMIT_EXCEEDED");
  return all;
}

let antiDdosCache = null;
export async function fetchAntiDdosConfig({ fetchImpl = fetch, forceRefresh = false } = {}) {
  if (!forceRefresh && antiDdosCache && Date.now() < antiDdosCache.validUntil) return antiDdosCache;
  const data = await fetchJson(LEVERUP_1CT.baseUrl + "/v2/trading/anti-ddos-config", {}, fetchImpl);
  if (!Array.isArray(data)) throw new Error("1CT anti-DDOS config must be an array");
  antiDdosCache = { fetchedAt: Date.now(), validUntil: Date.now() + 60_000, config: data };
  return antiDdosCache;
}

export async function readPairByBaseV4(pairBase, { rpcUrl = "https://rpc.monad.xyz", fetchImpl = fetch, blockTag = "latest" } = {}) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(pairBase || "")) throw new Error("Invalid pairBase");
  const encodedAddress = pairBase.toLowerCase().slice(2).padStart(64, "0");
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: LEVERUP_1CT.diamond, data: PAIR_BY_BASE_SELECTOR + encodedAddress }, blockTag] }),
    signal: AbortSignal.timeout(12_000),
  });
  const data = await response.json();
  if (!response.ok || data.error || !data.result) throw new Error("getPairByBaseV4 failed: " + JSON.stringify(data.error || data).slice(0, 300));
  return decodePairView(data.result);
}

export async function readGlobalMinimumNotional({ rpcUrl = "https://rpc.monad.xyz", fetchImpl = fetch, blockTag = "latest" } = {}) {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_call", params: [{ to: LEVERUP_1CT.diamond, data: MIN_NOTIONAL_SELECTOR }, blockTag] }),
    signal: AbortSignal.timeout(12_000),
  });
  const data = await response.json();
  if (!response.ok || data.error || !data.result || data.result.length < 130) throw new Error("getTradingConfig failed: " + JSON.stringify(data.error || data).slice(0, 300));
  return asWord(data.result, 32);
}

export async function readMarketInfoV2(pairBase, { publicClient = createLeverUpPublicClient(), blockNumber } = {}) {
  return publicClient.readContract({
    address: LEVERUP_1CT.diamond,
    abi: MARKET_INFO_V2_ABI,
    functionName: "getMarketInfoV2",
    args: [pairBase],
    ...(blockNumber == null ? {} : { blockNumber }),
  });
}

export async function readPositionsV4(traderAddress, pairBase, { publicClient = createLeverUpPublicClient(), blockNumber } = {}) {
  return publicClient.readContract({
    address: LEVERUP_1CT.diamond,
    abi: POSITION_V4_ABI,
    functionName: "getPositionsV4",
    args: [traderAddress, pairBase],
    ...(blockNumber == null ? {} : { blockNumber }),
  });
}

export async function readTokenBalancesAndAllowances(traderAddress, tokenAddresses, {
  diamond = LEVERUP_1CT.diamond, publicClient = createLeverUpPublicClient(),
} = {}) {
  const tokens = [...new Set((tokenAddresses || [])
    .filter(Boolean)
    .map((x) => String(x).toLowerCase())
    .filter((x) => x !== LEVERUP_1CT.zeroAddress.toLowerCase()))];
  const states = await Promise.all(tokens.map(async (token) => {
    const [balance, allowance] = await Promise.all([
      publicClient.readContract({ address: token, abi: ERC20_READ_ABI, functionName: "balanceOf", args: [traderAddress] }),
      publicClient.readContract({ address: token, abi: ERC20_READ_ABI, functionName: "allowance", args: [traderAddress, diamond] }),
    ]);
    return [token, { balance: BigInt(balance), allowance: BigInt(allowance) }];
  }));
  return Object.fromEntries(states);
}

export async function persistLeverUpPreflight(db, signalId, preflight, {
  decision = "PASS", rejectionReason = null, blockNumber = null,
} = {}) {
  if (!db?.prepare || !signalId || !preflight) throw new Error("PREFLIGHT_PERSISTENCE_INPUT_INVALID");
  const id = crypto.randomUUID();
  await db.prepare(`INSERT INTO leverup_preflight_snapshots (
    id, signal_id, symbol, pair_base, checked_at_ms, block_number,
    requested_leverage, market_max_leverage, notional_usd_raw, oracle_price_raw,
    mon_usd_price_raw, collateral_ratio, minimum_collateral_mon, available_margin_mon,
    fee_config_json, slippage_config_json, funding_rate_raw, holding_rate_long_raw,
    holding_rate_short_raw, decision, rejection_reason
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      id, String(signalId), preflight.pair, preflight.pairBase, preflight.checkedAt,
      blockNumber == null ? null : String(blockNumber), preflight.requestedLeverage,
      preflight.maxLeverageForNotional, String(preflight.notionalUsdRaw),
      String(preflight.oraclePriceRaw), String(preflight.monUsdPriceRaw),
      preflight.collateralRatio, preflight.minimumCollateralMon,
      preflight.marginBudget.availableMarginMon, JSON.stringify(preflight.protocolFeeConfig),
      JSON.stringify(preflight.slippageConfig), String(preflight.marketInfo?.fundingFeeRate ?? ""),
      String(preflight.longHoldingFeeRateRaw), String(preflight.shortHoldingFeeRateRaw),
      decision, rejectionReason,
    ).run();
  return id;
}

export async function persistPositionFeeSnapshot(db, position, sourceBlock = null) {
  if (!db?.prepare || !position?.positionHash) throw new Error("POSITION_SNAPSHOT_PERSISTENCE_INPUT_INVALID");
  await db.prepare(`INSERT OR REPLACE INTO leverup_position_fee_snapshots (
    position_hash, observed_at_ms, pair_base, symbol, is_long, margin_token,
    open_fee_raw, execution_fee_raw, funding_fee_raw, holding_fee_raw,
    accrued_funding_fee_raw, accrued_holding_fee_raw, earliest_close_time, source_block
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      position.positionHash, position.observedAt || Date.now(), position.pairBase,
      position.pair, position.isLong ? 1 : 0, position.marginToken,
      position.openFeeRaw, position.executionFeeRaw, position.fundingFeeRaw,
      position.holdingFeeRaw, position.accruedFundingFeeRaw,
      position.accruedHoldingFeeRaw, Number(position.earliestCloseTime),
      sourceBlock == null ? null : String(sourceBlock),
    ).run();
}

export async function persistSettlementReconciliation(db, settlement, source = {}) {
  if (!db?.prepare || !settlement?.positionHash) throw new Error("SETTLEMENT_PERSISTENCE_INPUT_INVALID");
  await db.prepare(`INSERT OR REPLACE INTO leverup_settlement_reconciliations (
    position_hash, symbol, close_time, close_price_raw, gross_pnl_raw,
    open_fee_raw, close_fee_raw, funding_fee_raw, holding_fee_raw,
    total_net_costs_raw, net_pnl_after_fees_raw, funding_since_last_snapshot_raw,
    holding_since_last_snapshot_raw, reconciled_at_ms, source_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      settlement.positionHash, settlement.pair, settlement.closeTime,
      settlement.closePriceRaw, settlement.grossPnlRaw, settlement.openFeeRaw,
      settlement.closeFeeRaw, settlement.fundingFeeRaw, settlement.holdingFeeRaw,
      settlement.totalNetCostsRaw, settlement.netPnlAfterFeesRaw,
      settlement.fundingSinceLastSnapshotRaw, settlement.holdingSinceLastSnapshotRaw,
      settlement.reconciledAt, JSON.stringify(source),
    ).run();
}

export function selectLeverageTier(leverageMargins, notionalUsd) {
  const notional = typeof notionalUsd === "bigint" ? notionalUsd : BigInt(notionalUsd);
  const tiers = [...(leverageMargins || [])]
    .filter((tier) => BigInt(tier.notionalUsdRaw) > 0n)
    .sort((a, b) => BigInt(a.notionalUsdRaw) < BigInt(b.notionalUsdRaw) ? -1 : 1);
  return tiers.find((tier) => notional <= BigInt(tier.notionalUsdRaw)) || null;
}

export function selectInferredLeverage(inferredLeverage, tierMaxLeverage, marketMaxLeverage) {
  const inferred = Number(inferredLeverage);
  const tierMax = Number(tierMaxLeverage);
  const marketMax = Number(marketMaxLeverage);
  if (!Number.isFinite(inferred) || inferred < MIN_EXECUTION_LEVERAGE) {
    throw new Error("INFERENCE_BELOW_50X: skip the trade instead of forcing leverage upward");
  }
  if (!Number.isFinite(tierMax) || tierMax < MIN_EXECUTION_LEVERAGE ||
      !Number.isFinite(marketMax) || marketMax < MIN_EXECUTION_LEVERAGE) {
    throw new Error("MARKET_MAX_LEVERAGE_BELOW_50X");
  }
  return Math.min(inferred, tierMax, marketMax);
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

export function estimateProtocolCosts({ notionalUsd, isLong, expectedHoldSeconds, pairView, marketInfo }) {
  const notional = Number(notionalUsd), seconds = Number(expectedHoldSeconds);
  if (!Number.isFinite(notional) || notional <= 0 || !Number.isFinite(seconds) || seconds < 0) throw new Error("COST_ESTIMATE_INPUTS_INVALID");
  const fees = pairView?.feeConfig;
  if (!fees || typeof fees.openFeeP !== "number" || typeof fees.closeFeeP !== "number") throw new Error("LIVE_PROTOCOL_FEE_CONFIG_MISSING");
  const openFeeUsd = fees.enabled === false ? 0 : notional * fees.openFeeP / 10_000;
  const closeFeeUsd = fees.enabled === false ? 0 : notional * fees.closeFeeP / 10_000;
  const holdingRateRaw = isLong ? pairView.longHoldingFeeRateRaw : pairView.shortHoldingFeeRateRaw;
  if (holdingRateRaw == null) throw new Error("LIVE_HOLDING_FEE_RATE_MISSING");
  const holdingFeeUsd = notional * seconds * Number(holdingRateRaw) / 1e12;
  if (marketInfo?.fundingFeeRate == null) throw new Error("LIVE_FUNDING_RATE_MISSING");
  const signedRate = Number(marketInfo.fundingFeeRate) / 1e18;
  const fundingFeeUsd = (isLong ? -1 : 1) * signedRate * notional * seconds;
  return {
    notionalUsd: notional, expectedHoldSeconds: seconds, openFeeUsd, closeFeeUsd,
    holdingFeeUsd, fundingFeeUsd,
    estimatedNetCostsUsd: openFeeUsd + closeFeeUsd + holdingFeeUsd - fundingFeeUsd,
    assumptions: [
      "Open/close fee base is position notional; pair percentages use 1e4.",
      "Holding fee is notional × elapsed seconds × the side-specific rate (1e12).",
      "Funding is projected using the current signed per-second rate; OI changes can reprice it.",
      "Close notional is assumed equal to entry notional; actual settlement overrides this estimate.",
    ],
  };
}

export function buildLeverUpPreflight({
  market, pairView, marketInfo, oraclePriceRaw, monUsdPriceRaw, minimumNotionalRaw,
  requestedLeverage, intendedNotionalUsd, isLong, expectedHoldSeconds,
  availableMarginMon, collateralRatio, reserveMon = 0,
  safetyBufferPct = 5, now = Date.now(),
}) {
  if (!market || market.status !== "AVAILABLE") throw new Error("MARKET_NOT_AVAILABLE");
  if (market.executionVenue && market.executionVenue !== "LEVERUP") throw new Error("MARKET_NOT_EXECUTED_BY_LEVERUP");
  if (!pairView?.leverageMargins?.length) throw new Error("LIVE_LEVERAGE_TIERS_MISSING");
  if (!oraclePriceRaw || BigInt(oraclePriceRaw) <= 0n) throw new Error("LEVERUP_ORACLE_PRICE_MISSING");
  if (!monUsdPriceRaw || BigInt(monUsdPriceRaw) <= 0n) throw new Error("LEVERUP_MON_ORACLE_PRICE_MISSING");
  if (minimumNotionalRaw == null || BigInt(minimumNotionalRaw) <= 0n) throw new Error("GLOBAL_MIN_NOTIONAL_MISSING");
  if (market.minHoldingSeconds == null) throw new Error("MIN_HOLDING_REQUIREMENT_MISSING");

  const minimumNotionalUsd = Number(minimumNotionalRaw) / 1e18;
  const notionalUsd = Number(intendedNotionalUsd ?? minimumNotionalUsd);
  if (!Number.isFinite(notionalUsd) || notionalUsd < minimumNotionalUsd) throw new Error("INTENDED_NOTIONAL_BELOW_VENUE_MINIMUM");
  const marketMaxLeverage = Math.max(...pairView.leverageMargins.map((x) => Number(x.maxLeverage)));
  const tier = selectLeverageTier(pairView.leverageMargins, BigInt(Math.round(notionalUsd * 1e18)));
  if (!tier) throw new Error("NO_LEVERAGE_TIER_FOR_NOTIONAL");
  const selectedLeverage = selectInferredLeverage(requestedLeverage, tier.maxLeverage, marketMaxLeverage);
  const leverage = assertMinimumLeverage({
    requestedLeverage: selectedLeverage, marketMaxLeverage,
    leverageMargins: pairView.leverageMargins, notionalUsd: BigInt(Math.round(notionalUsd * 1e18)),
  });
  const estimatedCosts = estimateProtocolCosts({
    notionalUsd, isLong: Boolean(isLong), expectedHoldSeconds: Number(expectedHoldSeconds), pairView, marketInfo,
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
    preflightPassed: true,
    chainId: 143,
    pair: market.pairName,
    pairBase: market.base.toLowerCase(),
    status: market.status,
    maxLeverageForNotional: leverage.tierMaxLeverage,
    inferredLeverage: Number(requestedLeverage),
    requestedLeverage: leverage.requestedLeverage,
    minHoldingSeconds: Number(market.minHoldingSeconds),
    oraclePriceUsd: Number(oraclePriceRaw) / 1e18,
    monUsdPrice: Number(monUsdPriceRaw) / 1e18,
    minimumNotionalUsd: notionalUsd,
    notionalUsdRaw: String(Math.round(notionalUsd * 1e18)),
    oraclePriceRaw: String(oraclePriceRaw),
    monUsdPriceRaw: String(monUsdPriceRaw),
    collateralRatio,
    minimumCollateralMon,
    marginBudget: margin,
    protocolFeeConfig: pairView.feeConfig,
    slippageConfig: pairView.slippageConfig,
    fundingFeeConfigRaw: pairView.fundingFeeConfigRaw,
    longHoldingFeeRateRaw: pairView.longHoldingFeeRateRaw,
    shortHoldingFeeRateRaw: pairView.shortHoldingFeeRateRaw,
    marketInfo,
    estimatedProtocolCosts: estimatedCosts,
    estimatedCarryCosts: {
      holdingFeeUsd: estimatedCosts.holdingFeeUsd,
      fundingFeeUsd: estimatedCosts.fundingFeeUsd,
      netCarryCostUsd: estimatedCosts.holdingFeeUsd - estimatedCosts.fundingFeeUsd,
    },
    estimationNote: "Projection uses live pair rates and the current funding rate. Reconcile it against getPositionsV4 and final closeInfo; actual settlement is authoritative.",
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
  const blockNumber = await publicClient.getBlockNumber();
  const blockTag = "0x" + blockNumber.toString(16);
  const [prices, pairView, minimumNotionalRaw, marketInfo, indexedPositions, onchainPositions] = await Promise.all([
    fetchLatestOraclePrices([pairBase, monMarket.base], { fetchImpl }),
    readPairByBaseV4(pairBase, { rpcUrl, fetchImpl, blockTag }),
    readGlobalMinimumNotional({ rpcUrl, fetchImpl, blockTag }),
    readMarketInfoV2(pairBase, { publicClient, blockNumber }),
    traderAddress ? fetchOpenPositions(traderAddress, { fetchImpl }) : Promise.resolve([]),
    traderAddress ? readPositionsV4(traderAddress, pairBase, { publicClient, blockNumber }) : Promise.resolve([]),
  ]);
  const feeTokens = antiDdos.config.filter((item) => item.enabled && item.feeToken)
    .map((item) => item.feeToken);
  const accountTokenStates = traderAddress
    ? await readTokenBalancesAndAllowances(traderAddress, [LEVERUP_TOKENS.WMON, LEVERUP_TOKENS.LVMON, ...feeTokens], { publicClient })
    : {};
  return {
    checkedAt: Date.now(),
    blockNumber: blockNumber.toString(),
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
    accountTokenStates: Object.fromEntries(Object.entries(accountTokenStates).map(([token, state]) => [token, {
      balance: state.balance.toString(), allowance: state.allowance.toString(),
    }])),
    antiDdosConfig: antiDdos,
    collateralRatio: collateralRatio ?? null,
  };
}
