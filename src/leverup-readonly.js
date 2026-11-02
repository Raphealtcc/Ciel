import {
  createPublicClient,
  defineChain,
  http,
  hexToString,
  parseUnits,
  formatUnits,
} from "viem";
import { LEVERUP_1CT, OneClickAction, selectFeeToken } from "./leverup-1ct.js";

export const LEVERUP_API = "https://service.leverup.xyz";
export const MIN_EXECUTION_LEVERAGE = 50;
export const LEVERUP_TOKENS = Object.freeze({
  WMON: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A",
  LVMON: "0x91b81bfbe3A747230F0529Aa28d8b2Bc898E6D56",
  USDC: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
  LVUSD: "0xFD44B35139Ae53FFF7d8F2A9869c503D987f00d1",
});
export const MIN_NOTIONAL_SELECTOR = "0x3569c2f7";

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

const AGENT_AUTH_ABI = [{
  type: "function", name: "getAgentAuth", stateMutability: "view",
  inputs: [{ name: "trader", type: "address" }, { name: "agent", type: "address" }],
  outputs: [{ type: "tuple", name: "", components: [
    { name: "agent", type: "address" }, { name: "name", type: "bytes32" },
    { name: "permissions", type: "uint256" }, { name: "authorizedAt", type: "uint32" },
  ] }],
}];
const LAST_NONCE_ABI = [{
  type: "function", name: "getLastNonce", stateMutability: "view",
  inputs: [{ name: "trader", type: "address" }, { name: "signer", type: "address" }],
  outputs: [{ name: "", type: "uint64" }],
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

const PAIR_BY_BASE_V4_ABI = [{
  type: "function", name: "getPairByBaseV4", stateMutability: "view",
  inputs: [{ name: "base", type: "address" }],
  outputs: [{ type: "tuple", name: "", components: [
    { name: "name", type: "string" },
    { name: "base", type: "address" },
    { name: "basePosition", type: "uint16" },
    { name: "pairType", type: "uint8" },
    { name: "status", type: "uint8" },
    { name: "maxLongOiUsd", type: "uint256" },
    { name: "maxShortOiUsd", type: "uint256" },
    { name: "fundingFeePerSecondP", type: "uint256" },
    { name: "minFundingFeeR", type: "uint256" },
    { name: "maxFundingFeeR", type: "uint256" },
    { name: "leverageMargins", type: "tuple[]", components: [
      { name: "notionalUsd", type: "uint256" },
      { name: "tier", type: "uint16" },
      { name: "maxLeverage", type: "uint16" },
      { name: "initialLostP", type: "uint16" },
      { name: "liqLostP", type: "uint16" },
    ] },
    { name: "slippageConfigIndex", type: "uint16" },
    { name: "slippagePosition", type: "uint16" },
    { name: "slippageConfig", type: "tuple", components: [
      { name: "name", type: "string" },
      { name: "onePercentDepthAboveUsd", type: "uint256" },
      { name: "onePercentDepthBelowUsd", type: "uint256" },
      { name: "slippageLongP", type: "uint16" },
      { name: "slippageShortP", type: "uint16" },
      { name: "index", type: "uint16" },
      { name: "slippageType", type: "uint8" },
      { name: "enable", type: "bool" },
      { name: "longThresholdUsd", type: "uint256" },
      { name: "shortThresholdUsd", type: "uint256" },
    ] },
    { name: "feeConfigIndex", type: "uint16" },
    { name: "feePosition", type: "uint16" },
    { name: "feeConfig", type: "tuple", components: [
      { name: "name", type: "string" },
      { name: "index", type: "uint16" },
      { name: "openFeeP", type: "uint16" },
      { name: "closeFeeP", type: "uint16" },
      { name: "enable", type: "bool" },
      { name: "shareP", type: "uint24" },
      { name: "minCloseFeeP", type: "uint24" },
      { name: "lvTokenDiscountP", type: "uint24" },
    ] },
    { name: "longHoldingFeeRate", type: "uint40" },
    { name: "shortHoldingFeeRate", type: "uint40" },
    { name: "holdingTimeThresholdSizeUSD", type: "uint256" },
    { name: "minHoldingSeconds", type: "uint256" },
  ] }],
}];

export function normalizePairView(pair) {
  return {
    name: pair.name,
    base: pair.base,
    basePosition: Number(pair.basePosition),
    pairType: Number(pair.pairType),
    status: Number(pair.status),
    maxLongOiUsdRaw: String(pair.maxLongOiUsd),
    maxShortOiUsdRaw: String(pair.maxShortOiUsd),
    fundingFeePerSecondPRaw: String(pair.fundingFeePerSecondP),
    minFundingFeeRRaw: String(pair.minFundingFeeR),
    maxFundingFeeRRaw: String(pair.maxFundingFeeR),
    leverageMargins: pair.leverageMargins.map((tier) => ({
      notionalUsdRaw: String(tier.notionalUsd),
      tier: Number(tier.tier),
      maxLeverage: Number(tier.maxLeverage),
      initialLostPRaw: String(tier.initialLostP),
      liqLostPRaw: String(tier.liqLostP),
    })),
    slippageConfig: {
      name: pair.slippageConfig.name,
      onePercentDepthAboveUsdRaw: String(pair.slippageConfig.onePercentDepthAboveUsd),
      onePercentDepthBelowUsdRaw: String(pair.slippageConfig.onePercentDepthBelowUsd),
      slippageLongP: Number(pair.slippageConfig.slippageLongP),
      slippageShortP: Number(pair.slippageConfig.slippageShortP),
      index: Number(pair.slippageConfig.index),
      slippageType: Number(pair.slippageConfig.slippageType),
      enabled: Boolean(pair.slippageConfig.enable),
      longThresholdUsdRaw: String(pair.slippageConfig.longThresholdUsd),
      shortThresholdUsdRaw: String(pair.slippageConfig.shortThresholdUsd),
    },
    feeConfig: {
      name: pair.feeConfig.name,
      index: Number(pair.feeConfig.index),
      openFeeP: Number(pair.feeConfig.openFeeP),
      closeFeeP: Number(pair.feeConfig.closeFeeP),
      enabled: Boolean(pair.feeConfig.enable),
      shareP: Number(pair.feeConfig.shareP),
      minCloseFeeP: Number(pair.feeConfig.minCloseFeeP),
      lvTokenDiscountP: Number(pair.feeConfig.lvTokenDiscountP),
    },
    longHoldingFeeRateRaw: String(pair.longHoldingFeeRate),
    shortHoldingFeeRateRaw: String(pair.shortHoldingFeeRate),
    holdingTimeThresholdSizeUSDRaw: String(pair.holdingTimeThresholdSizeUSD),
    minHoldingSeconds: Number(pair.minHoldingSeconds),
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

export async function readPairByBaseV4(pairBase, { publicClient = createLeverUpPublicClient(), blockNumber } = {}) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(pairBase || "")) throw new Error("Invalid pairBase");
  const pair = await publicClient.readContract({
    address: LEVERUP_1CT.diamond,
    abi: PAIR_BY_BASE_V4_ABI,
    functionName: "getPairByBaseV4",
    args: [pairBase],
    ...(blockNumber == null ? {} : { blockNumber }),
  });
  return normalizePairView(pair);
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

export function hasAgentPermission(permissions, action) {
  const mask = BigInt(permissions);
  if (mask === (2n ** 256n - 1n)) return true;
  return (mask & (1n << BigInt(action))) !== 0n;
}

export async function readAgentAuthorization(traderAddress, agentAddress, { publicClient = createLeverUpPublicClient() } = {}) {
  const auth = await publicClient.readContract({
    address: LEVERUP_1CT.diamond, abi: AGENT_AUTH_ABI,
    functionName: "getAgentAuth", args: [traderAddress, agentAddress],
  });
  const authorizedAgent = auth.agent ?? auth[0];
  const permissions = BigInt(auth.permissions ?? auth[2] ?? 0n);
  const authorized = String(authorizedAgent).toLowerCase() === String(agentAddress).toLowerCase();
  return {
    authorized,
    agentAddress: authorizedAgent,
    permissions: permissions.toString(),
    authorizedAt: Number(auth.authorizedAt ?? auth[3] ?? 0),
    canMarketOpen: authorized && hasAgentPermission(permissions, 0),
    canMarketClose: authorized && hasAgentPermission(permissions, 1),
    canPartialClose: authorized && hasAgentPermission(permissions, 9),
  };
}

export async function readLastAgentNonce(traderAddress, agentAddress, { publicClient = createLeverUpPublicClient() } = {}) {
  return publicClient.readContract({
    address: LEVERUP_1CT.diamond, abi: LAST_NONCE_ABI,
    functionName: "getLastNonce", args: [traderAddress, agentAddress],
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
    requested_leverage, market_max_leverage, tier_max_leverage, notional_usd_raw, oracle_price_raw,
    mon_usd_price_raw, collateral_ratio, minimum_collateral_mon, available_margin_mon,
    fee_config_json, slippage_config_json, funding_rate_raw, holding_rate_long_raw,
    holding_rate_short_raw, estimated_costs_json, decision, rejection_reason
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      id, String(signalId), preflight.pair, preflight.pairBase, preflight.checkedAt,
      blockNumber == null ? null : String(blockNumber), preflight.requestedLeverage,
      preflight.marketMaxLeverage, preflight.maxLeverageForNotional, String(preflight.notionalUsdRaw),
      String(preflight.oraclePriceRaw), String(preflight.monUsdPriceRaw),
      preflight.collateralRatio, preflight.minimumCollateralMon,
      preflight.marginBudget.availableMarginMon, JSON.stringify(preflight.protocolFeeConfig),
      JSON.stringify(preflight.slippageConfig), String(preflight.marketInfo?.fundingFeeRate ?? ""),
      String(preflight.longHoldingFeeRateRaw), String(preflight.shortHoldingFeeRateRaw),
      JSON.stringify(preflight.estimatedProtocolCosts ?? null), decision, rejectionReason,
    ).run();
  return id;
}

export async function persistPositionFeeSnapshot(db, position, sourceBlock = null, minIntervalMs = 300_000) {
  if (!db?.prepare || !position?.positionHash) throw new Error("POSITION_SNAPSHOT_PERSISTENCE_INPUT_INVALID");
  const latest = await db.prepare("SELECT MAX(observed_at_ms) AS observed_at_ms FROM leverup_position_fee_snapshots WHERE position_hash = ?")
    .bind(position.positionHash).first();
  if (latest?.observed_at_ms && Date.now() - Number(latest.observed_at_ms) < minIntervalMs) {
    return { stored: false, reason: "SNAPSHOT_INTERVAL_NOT_REACHED" };
  }
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
  return { stored: true };
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

export function calculateNotionalFromMarginMon({ marginMon, leverage, monUsdPrice, collateralRatio }) {
  const margin = Number(marginMon), lev = Number(leverage), price = Number(monUsdPrice), ratio = Number(collateralRatio);
  if (![margin, lev, price, ratio].every(Number.isFinite) ||
      margin <= 0 || lev < MIN_EXECUTION_LEVERAGE || price <= 0 || ratio <= 0 || ratio > 1) {
    throw new Error("NOTIONAL_SIZING_INPUTS_INVALID_OR_UNVERIFIED");
  }
  return margin * lev * price * ratio;
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

export function estimateProtocolCosts({ notionalUsd, isLong, expectedHoldSeconds, pairView, marketInfo, tokenIn = LEVERUP_TOKENS.WMON }) {
  const notional = Number(notionalUsd), seconds = Number(expectedHoldSeconds);
  if (!Number.isFinite(notional) || notional <= 0 || !Number.isFinite(seconds) || seconds < 0) throw new Error("COST_ESTIMATE_INPUTS_INVALID");
  const fees = pairView?.feeConfig;
  if (!fees || typeof fees.openFeeP !== "number" || typeof fees.closeFeeP !== "number") throw new Error("LIVE_PROTOCOL_FEE_CONFIG_MISSING");
  if (Number(fees.minCloseFeeP || 0) > 0) throw new Error("MIN_CLOSE_FEE_FORMULA_NOT_VERIFIED");
  const usesLvToken = [LEVERUP_TOKENS.LVMON, LEVERUP_TOKENS.LVUSD].some((x) => x.toLowerCase() === String(tokenIn).toLowerCase());
  const discount = usesLvToken ? Number(fees.lvTokenDiscountP || 0) / 100_000 : 0;
  const openFeeUsd = fees.enabled === false ? 0 : notional * fees.openFeeP / 10_000 * (1 - discount);
  const closeFeeUsd = fees.enabled === false ? 0 : notional * fees.closeFeeP / 10_000 * (1 - discount);
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
  requestedLeverage, intendedNotionalUsd, isLong, expectedHoldSeconds, tokenIn = LEVERUP_TOKENS.WMON,
  availableMarginMon, collateralRatio, reserveMon = 0,
  safetyBufferPct = 5, now = Date.now(),
}) {
  if (!market || market.status !== "AVAILABLE") throw new Error("MARKET_NOT_AVAILABLE");
  if (market.executionVenue === "HYPERLIQUID" ||
      (market.executionVenue && !["POOL", "LEVERUP"].includes(market.executionVenue))) {
    throw new Error("MARKET_NOT_EXECUTED_BY_LEVERUP");
  }
  if (!pairView?.leverageMargins?.length) throw new Error("LIVE_LEVERAGE_TIERS_MISSING");
  if (!oraclePriceRaw || BigInt(oraclePriceRaw) <= 0n) throw new Error("LEVERUP_ORACLE_PRICE_MISSING");
  if (!monUsdPriceRaw || BigInt(monUsdPriceRaw) <= 0n) throw new Error("LEVERUP_MON_ORACLE_PRICE_MISSING");
  if (minimumNotionalRaw == null || BigInt(minimumNotionalRaw) <= 0n) throw new Error("GLOBAL_MIN_NOTIONAL_MISSING");
  const minHoldingSeconds = Number(pairView.minHoldingSeconds);
  if (!Number.isFinite(minHoldingSeconds) || minHoldingSeconds < 0) throw new Error("MIN_HOLDING_REQUIREMENT_MISSING");
  if (market.minHoldingSeconds != null && Number(market.minHoldingSeconds) !== minHoldingSeconds) {
    throw new Error("PAIR_MIN_HOLDING_DATA_MISMATCH");
  }
  if (!Number.isFinite(Number(expectedHoldSeconds)) || Number(expectedHoldSeconds) < minHoldingSeconds) {
    throw new Error("MIN_HOLDING_DURATION_NOT_MET");
  }
  if (typeof isLong !== "boolean") throw new Error("TRADE_DIRECTION_MISSING");

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
    notionalUsd, isLong, expectedHoldSeconds: Number(expectedHoldSeconds), pairView, marketInfo, tokenIn,
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
    marketMaxLeverage,
    maxLeverageForNotional: leverage.tierMaxLeverage,
    inferredLeverage: Number(requestedLeverage),
    requestedLeverage: leverage.requestedLeverage,
    minHoldingSeconds,
    oraclePriceUsd: Number(oraclePriceRaw) / 1e18,
    monUsdPrice: Number(monUsdPriceRaw) / 1e18,
    minimumNotionalUsd,
    notionalUsd,
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

function ceilDiv(numerator, denominator) {
  if (denominator <= 0n) throw new Error("DIVISOR_MUST_BE_POSITIVE");
  return (numerator + denominator - 1n) / denominator;
}

function minBigInt(...values) {
  return values.reduce((a, b) => a < b ? a : b);
}

export function buildMarketOpenPlan({
  snapshot, desiredMarginMon, maxTradeMarginMon, inferredLeverage, side,
  expectedHoldSeconds, reserveMon = 0, stopLossPriceRaw = 0n,
  takeProfitPriceRaw = 0n, broker = 0, extraFeeRaw = 0n, now = Date.now(),
}) {
  if (!snapshot?.market || !snapshot?.pairView || !snapshot?.accountTokenStates || !snapshot?.antiDdosConfig) {
    throw new Error("MARKET_OPEN_SNAPSHOT_INCOMPLETE");
  }
  if (side !== "LONG" && side !== "SHORT") throw new Error("TRADE_DIRECTION_INVALID");
  const isLong = side === "LONG";
  const tokenIn = LEVERUP_TOKENS.WMON;
  const lvToken = LEVERUP_TOKENS.LVMON;
  const marginRaw = parseUnits(String(desiredMarginMon), 18);
  const maxTradeRaw = parseUnits(String(maxTradeMarginMon), 18);
  const reserveRaw = parseUnits(String(reserveMon), 18);
  const monPriceRaw = BigInt(snapshot.monUsdPriceRaw);
  const pairPriceRaw = BigInt(snapshot.oraclePriceRaw);
  const collateralRatioRaw = parseUnits(String(snapshot.collateralRatio), 18);
  const minNotionalRaw = BigInt(snapshot.minimumNotionalRaw);
  if (marginRaw <= 0n || maxTradeRaw <= 0n || reserveRaw < 0n) throw new Error("TRADE_MARGIN_INPUT_INVALID");
  if (monPriceRaw <= 0n || pairPriceRaw <= 0n || collateralRatioRaw <= 0n || collateralRatioRaw > 10n ** 18n) {
    throw new Error("LIVE_COLLATERAL_OR_ORACLE_DATA_INVALID");
  }
  const wmonState = snapshot.accountTokenStates[tokenIn.toLowerCase()];
  if (!wmonState) throw new Error("WMON_ACCOUNT_STATE_MISSING");
  const wmonBalanceRaw = BigInt(wmonState.balance);
  const wmonAllowanceRaw = BigInt(wmonState.allowance);
  const availableRaw = wmonBalanceRaw > reserveRaw ? wmonBalanceRaw - reserveRaw : 0n;
  if (marginRaw > availableRaw) throw new Error("DESIRED_MARGIN_EXCEEDS_AVAILABLE_WMON");
  const tiers = snapshot.pairView.leverageMargins;
  const marketMaxLeverage = Math.max(...tiers.map((x) => Number(x.maxLeverage)));
  const minTier = selectLeverageTier(tiers, minNotionalRaw);
  if (!minTier) throw new Error("NO_TIER_FOR_GLOBAL_MINIMUM_NOTIONAL");
  const leverage = selectInferredLeverage(inferredLeverage, minTier.maxLeverage, marketMaxLeverage);
  const eligibleTiers = tiers.filter((tier) => Number(tier.maxLeverage) >= leverage);
  if (!eligibleTiers.length) throw new Error("NO_TIER_SUPPORTS_INFERRED_LEVERAGE");
  const maxNotionalRaw = eligibleTiers.reduce((max, tier) => {
    const value = BigInt(tier.notionalUsdRaw);
    return value > max ? value : max;
  }, 0n);
  const effectiveMonPriceRaw = monPriceRaw * collateralRatioRaw / (10n ** 18n);
  const leverageDenominator = effectiveMonPriceRaw * BigInt(leverage);
  const minMarginRaw = ceilDiv(minNotionalRaw * (10n ** 18n), leverageDenominator);
  const maxMarginForTierRaw = maxNotionalRaw * (10n ** 18n) / leverageDenominator;
  const marginUsedRaw = minBigInt(marginRaw, maxTradeRaw, availableRaw, maxMarginForTierRaw);
  if (marginUsedRaw < minMarginRaw) {
    throw new Error("INSUFFICIENT_MARGIN_FOR_50X_PLUS_TIER_MINIMUM");
  }
  let notionalRaw = marginUsedRaw * effectiveMonPriceRaw * BigInt(leverage) / (10n ** 18n);
  if (notionalRaw < minNotionalRaw || notionalRaw > maxNotionalRaw) throw new Error("FINAL_NOTIONAL_OUTSIDE_LEVERAGE_TIER");
  const tier = selectLeverageTier(tiers, notionalRaw);
  if (!tier || Number(tier.maxLeverage) < leverage) throw new Error("FINAL_NOTIONAL_TIER_DOES_NOT_SUPPORT_LEVERAGE");
  const marginMonUsed = formatUnits(marginUsedRaw, 18);
  const notionalUsd = Number(notionalRaw) / 1e18;
  const preflight = buildLeverUpPreflight({
    market: snapshot.market,
    pairView: snapshot.pairView,
    marketInfo: snapshot.marketInfo,
    oraclePriceRaw: snapshot.oraclePriceRaw,
    monUsdPriceRaw: snapshot.monUsdPriceRaw,
    minimumNotionalRaw: snapshot.minimumNotionalRaw,
    requestedLeverage: leverage,
    intendedNotionalUsd: notionalUsd,
    isLong,
    expectedHoldSeconds,
    tokenIn,
    availableMarginMon: Number(formatUnits(availableRaw, 18)),
    collateralRatio: snapshot.collateralRatio,
    reserveMon: 0,
    safetyBufferPct: 0,
    now,
  });
  preflight.inferredLeverage = Number(inferredLeverage);
  const fees = snapshot.pairView.feeConfig;
  if (!fees || typeof fees.openFeeP !== "number") throw new Error("LIVE_OPEN_FEE_CONFIG_MISSING");
  const usesLvToken = [LEVERUP_TOKENS.LVMON, LEVERUP_TOKENS.LVUSD].some((x) => x.toLowerCase() === tokenIn.toLowerCase());
  const discountP = usesLvToken ? BigInt(fees.lvTokenDiscountP || 0) : 0n;
  const grossOpenFeeUsdRaw = fees.enabled === false ? 0n : notionalRaw * BigInt(fees.openFeeP) / 10_000n;
  const openFeeUsdRaw = grossOpenFeeUsdRaw * (100_000n - discountP) / 100_000n;
  const openFeeTokenInRaw = ceilDiv(openFeeUsdRaw * (10n ** 18n), monPriceRaw);
  const amountInRaw = marginUsedRaw + openFeeTokenInRaw;
  const extraFee = BigInt(extraFeeRaw);
  const totalCollateralSpend = amountInRaw + extraFee;
  if (amountInRaw > (2n ** 96n - 1n) || extraFee > (2n ** 96n - 1n)) throw new Error("ONECLICK_UINT96_OVERFLOW");
  if (totalCollateralSpend > availableRaw) throw new Error("WMON_BALANCE_INSUFFICIENT_AFTER_RESERVE_FOR_MARGIN_AND_OPEN_FEE");
  if (wmonBalanceRaw < totalCollateralSpend) throw new Error("WMON_BALANCE_INSUFFICIENT_FOR_MARGIN_AND_OPEN_FEE");
  if (wmonAllowanceRaw < totalCollateralSpend) throw new Error("WMON_DIAMOND_ALLOWANCE_INSUFFICIENT");
  const antiDdos = snapshot.antiDdosConfig;
  if (!antiDdos.validUntil || now >= Number(antiDdos.validUntil)) throw new Error("ANTIDDOS_CONFIG_STALE");
  const feeSelection = selectFeeToken(
    OneClickAction.MARKET_OPEN,
    antiDdos.config,
    snapshot.accountTokenStates,
    [{ token: tokenIn, amount: totalCollateralSpend }],
  );
  const qtyRaw = notionalRaw * (10n ** 10n) / pairPriceRaw;
  if (qtyRaw <= 0n || qtyRaw > (2n ** 128n - 1n)) throw new Error("ONECLICK_QTY_OUT_OF_RANGE");
  const slippage = snapshot.pairView.slippageConfig;
  if (!slippage?.enabled) throw new Error("LIVE_SLIPPAGE_CONFIG_DISABLED_OR_MISSING");
  const slippageP = BigInt(isLong ? slippage.slippageLongP : slippage.slippageShortP);
  if (slippageP < 0n || slippageP > 10_000n) throw new Error("LIVE_SLIPPAGE_BOUND_INVALID");
  const worstPriceRaw = isLong
    ? pairPriceRaw * (10_000n + slippageP) / 10_000n
    : pairPriceRaw * (10_000n - slippageP) / 10_000n;
  const stopLoss = BigInt(stopLossPriceRaw);
  const takeProfit = BigInt(takeProfitPriceRaw);
  if (isLong && ((stopLoss > 0n && stopLoss >= pairPriceRaw) || (takeProfit > 0n && takeProfit <= pairPriceRaw))) {
    throw new Error("LONG_TP_SL_DIRECTION_INVALID");
  }
  if (!isLong && ((stopLoss > 0n && stopLoss <= pairPriceRaw) || (takeProfit > 0n && takeProfit >= pairPriceRaw))) {
    throw new Error("SHORT_TP_SL_DIRECTION_INVALID");
  }
  const actionValues = [
    snapshot.pairView.base.toLowerCase(), isLong, tokenIn, lvToken, amountInRaw,
    qtyRaw, worstPriceRaw, stopLoss, takeProfit, Number(broker), extraFee,
  ];
  const lastNonce = BigInt(snapshot.lastAgentNonce || "0");
  const wallClockNonce = BigInt(now);
  const nonce = (lastNonce + 1n) > wallClockNonce ? lastNonce + 1n : wallClockNonce;
  return {
    mode: "DRY_RUN_ONLY",
    action: OneClickAction.MARKET_OPEN,
    actionValues,
    feeToken: feeSelection.feeToken,
    antiDdosFee: feeSelection.antiDdosFee,
    nonce: nonce.toString(),
    deadline: Math.floor(now / 1000) + 300,
    marginMonUsed,
    notionalUsd,
    selectedLeverage: leverage,
    tierMaxLeverage: Number(tier.maxLeverage),
    maxNotionalUsdForLeverage: Number(maxNotionalRaw) / 1e18,
    amountInRaw: amountInRaw.toString(),
    openFeeTokenInRaw: openFeeTokenInRaw.toString(),
    qtyRaw: qtyRaw.toString(),
    worstPriceRaw: worstPriceRaw.toString(),
    preflight,
    agentAuthorization: snapshot.agentAuthorization,
    agentAddress: snapshot.agentAddress,
    traderAddress: snapshot.traderAddress,
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

export function reconcileClosedPosition(closedPosition, lastLiveSnapshot = null, estimate = null, {
  marginTokenDecimals = 18, marginTokenPriceUsd = null,
} = {}) {
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
  const price = marginTokenPriceUsd == null ? null : Number(marginTokenPriceUsd);
  const decimals = Number(marginTokenDecimals);
  const actualNetCostsUsd = Number.isFinite(price) && price > 0 && Number.isInteger(decimals) && decimals >= 0
    ? Number(totalNetCosts) / (10 ** decimals) * price : null;
  const estimatedNetCostsUsd = estimate?.estimatedProtocolCosts?.estimatedNetCostsUsd
    ?? estimate?.estimatedNetCostsUsd ?? null;
  const estimatedActualVarianceUsd = actualNetCostsUsd == null || estimatedNetCostsUsd == null
    ? null : actualNetCostsUsd - Number(estimatedNetCostsUsd);
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
    actualNetCostsUsd,
    estimatedNetCostsUsd,
    estimatedActualVarianceUsd,
    marginTokenPriceUsd: price,
    marginTokenDecimals: decimals,
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
  traderAddress, agentAddress, symbol, collateralRatio, rpcUrl = "https://rpc.monad.xyz",
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
  if (market.executionVenue === "HYPERLIQUID") throw new Error("MARKET_NOT_EXECUTED_BY_LEVERUP");
  const monMarket = pairs.find((item) => item.symbol === "MON" || item.pairName === "MON/USD");
  if (!monMarket?.base) throw new Error("MON_COLLATERAL_PRICE_PAIR_MISSING");
  const blockNumber = await publicClient.getBlockNumber();
  const blockTag = "0x" + blockNumber.toString(16);
  const [prices, pairView, minimumNotionalRaw, marketInfo, indexedPositions, onchainPositions] = await Promise.all([
    fetchLatestOraclePrices([pairBase, monMarket.base], { fetchImpl }),
    readPairByBaseV4(pairBase, { publicClient, blockNumber }),
    readGlobalMinimumNotional({ rpcUrl, fetchImpl, blockTag }),
    readMarketInfoV2(pairBase, { publicClient, blockNumber }),
    traderAddress ? fetchOpenPositions(traderAddress, { fetchImpl }) : Promise.resolve([]),
    traderAddress ? readPositionsV4(traderAddress, pairBase, { publicClient, blockNumber }) : Promise.resolve([]),
  ]);
  const feeTokens = antiDdos.config.filter((item) => item.enabled && item.feeToken)
    .map((item) => item.feeToken);
  const [accountTokenStates, agentAuthorization, lastAgentNonce] = traderAddress
    ? await Promise.all([
      readTokenBalancesAndAllowances(traderAddress, [LEVERUP_TOKENS.WMON, LEVERUP_TOKENS.LVMON, LEVERUP_TOKENS.USDC, LEVERUP_TOKENS.LVUSD, ...feeTokens], { publicClient }),
      agentAddress ? readAgentAuthorization(traderAddress, agentAddress, { publicClient }) : Promise.resolve(null),
      agentAddress ? readLastAgentNonce(traderAddress, agentAddress, { publicClient }) : Promise.resolve(null),
    ])
    : [{}, null, null];
  return {
    checkedAt: Date.now(),
    blockNumber: blockNumber.toString(),
    traderAddress: traderAddress || null,
    agentAddress: agentAddress || null,
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
    agentAuthorization,
    lastAgentNonce: lastAgentNonce == null ? null : String(lastAgentNonce),
    antiDdosConfig: antiDdos,
    collateralRatio: collateralRatio ?? null,
  };
}
