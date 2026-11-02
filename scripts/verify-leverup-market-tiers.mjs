import { readFile, writeFile } from "node:fs/promises";
import vm from "node:vm";

const DIAMOND = "0xea1b8E4aB7f14F7dCA68c5B214303B13078FC5ec";
const RPC = process.env.LEVERUP_RPC_URL || "https://rpc.monad.xyz";
const PAIRS_URL = "https://service.leverup.xyz/v1/pairs?size=100&block_chain=MONAD";
const HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info";
const WATCHLIST = [
  "BTC", "ETH", "MON", "BNB", "XRP", "HYPE", "ONDO", "KPEPE", "QNT", "ZEC",
  "TRX", "AAVE", "ADA", "CASHCAT", "DOGE", "LINK", "LIT", "PONS", "PUMP",
  "SEI", "SOL", "SUI", "UNI", "VIRTUAL", "XMR"
];

const PAIR_SELECTOR = "0x9bd39764"; // getPairByBaseV4(address), verified PairsManagerFacet ABI
const TRADING_CONFIG_SELECTOR = "0x3569c2f7"; // getTradingConfig(), verified TradingConfigFacet ABI

async function fetchJson(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const body = await response.text();
  if (!response.ok) throw new Error("HTTP " + response.status + " for " + url + ": " + body.slice(0, 300));
  return JSON.parse(body);
}

async function rpc(method, params) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: attempt + 1, method, params }),
        signal: AbortSignal.timeout(20_000)
      });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(JSON.stringify(data.error || data).slice(0, 500));
      return data.result;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function hyperliquidMeta(dex) {
  return fetchJson(HYPERLIQUID_INFO, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(dex ? { type: "meta", dex } : { type: "meta" })
  });
}

function asWord(hex, byteOffset) {
  const start = 2 + byteOffset * 2;
  const word = hex.slice(start, start + 64);
  if (word.length !== 64) throw new Error("ABI word out of bounds at byte " + byteOffset);
  return BigInt("0x" + word);
}

function asNumber(hex, byteOffset) {
  const value = asWord(hex, byteOffset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("ABI number exceeds safe integer");
  return Number(value);
}

function asString(hex, tupleBase, fieldWordIndex) {
  const offset = asNumber(hex, tupleBase + fieldWordIndex * 32);
  const start = tupleBase + offset;
  const length = asNumber(hex, start);
  const byteStart = 2 + (start + 32) * 2;
  const byteEnd = byteStart + length * 2;
  return Buffer.from(hex.slice(byteStart, byteEnd), "hex").toString("utf8");
}

function decodePairView(result) {
  if (!result || result === "0x") throw new Error("getPairByBaseV4 returned empty data");
  const tupleBase = asNumber(result, 0);
  const name = asString(result, tupleBase, 0);
  const base = "0x" + result.slice(2 + (tupleBase + 32) * 2 + 24, 2 + (tupleBase + 32) * 2 + 64);
  const pairType = asNumber(result, tupleBase + 3 * 32);
  const status = asNumber(result, tupleBase + 4 * 32);
  const leverageOffset = asNumber(result, tupleBase + 10 * 32);
  const leverageArrayBase = tupleBase + leverageOffset;
  const leverageCount = asNumber(result, leverageArrayBase);
  const leverageMargins = [];
  for (let i = 0; i < leverageCount; i++) {
    const entry = leverageArrayBase + 32 + i * 5 * 32;
    leverageMargins.push({
      notionalUsdRaw: asWord(result, entry).toString(),
      tier: asNumber(result, entry + 32),
      maxLeverage: asNumber(result, entry + 64),
      initialLostPRaw: asWord(result, entry + 96).toString(),
      liqLostPRaw: asWord(result, entry + 128).toString()
    });
  }
  const slippageBase = tupleBase + asNumber(result, tupleBase + 13 * 32);
  const feeBase = tupleBase + asNumber(result, tupleBase + 16 * 32);
  const slippageConfig = {
    name: asString(result, slippageBase, 0),
    onePercentDepthAboveUsdRaw: asWord(result, slippageBase + 32).toString(),
    onePercentDepthBelowUsdRaw: asWord(result, slippageBase + 64).toString(),
    slippageLongP: asNumber(result, slippageBase + 96),
    slippageShortP: asNumber(result, slippageBase + 128),
    index: asNumber(result, slippageBase + 160),
    slippageType: asNumber(result, slippageBase + 192),
    enabled: asNumber(result, slippageBase + 224) !== 0,
    longThresholdUsdRaw: asWord(result, slippageBase + 256).toString(),
    shortThresholdUsdRaw: asWord(result, slippageBase + 288).toString()
  };
  const feeConfig = {
    name: asString(result, feeBase, 0),
    index: asNumber(result, feeBase + 32),
    openFeeP: asNumber(result, feeBase + 64),
    closeFeeP: asNumber(result, feeBase + 96),
    enabled: asNumber(result, feeBase + 128) !== 0,
    shareP: asNumber(result, feeBase + 160),
    minCloseFeeP: asNumber(result, feeBase + 192)
  };
  return {
    name, base, pairType, status, leverageMargins, slippageConfig, feeConfig,
    maxLongOiUsdRaw: asWord(result, tupleBase + 5 * 32).toString(),
    maxShortOiUsdRaw: asWord(result, tupleBase + 6 * 32).toString(),
    fundingFeePerBlockPRaw: asWord(result, tupleBase + 7 * 32).toString(),
    minFundingFeeRRaw: asWord(result, tupleBase + 8 * 32).toString(),
    maxFundingFeeRRaw: asWord(result, tupleBase + 9 * 32).toString(),
    longHoldingFeeRateRaw: asWord(result, tupleBase + 17 * 32).toString(),
    shortHoldingFeeRateRaw: asWord(result, tupleBase + 18 * 32).toString()
  };
}

async function mapLimit(items, limit, fn) {
  const output = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

const symbolsSource = await readFile("recovered-src/symbols.js.part-001", "utf8");
const sourceMapMatch = symbolsSource.match(/var LEVERUP_MARKET_MAX_LEVERAGE = Object\.freeze\((\{[\s\S]*?\})\);/);
if (!sourceMapMatch) throw new Error("Could not extract the recovered source leverage map");
const sourceMap = vm.runInNewContext("(" + sourceMapMatch[1] + ")");
const patchedSource = await readFile("reconstructed/patched-worker.js", "utf8");
const patchedMapMatch = patchedSource.match(/var LEVERUP_MARKET_MAX_LEVERAGE = Object\.freeze\((\{[\s\S]*?\})\);/);
if (!patchedMapMatch) throw new Error("Could not extract the staging patched leverage map");
const stagingMap = vm.runInNewContext("(" + patchedMapMatch[1] + ")");

const pairsResponse = await fetchJson(PAIRS_URL);
const allPairs = pairsResponse.content || [];
const selected = WATCHLIST.map((symbol) => {
  const pair = allPairs.find((item) =>
    item.pairName === symbol + "/USD" &&
    item.isDegenPair !== true
  );
  return pair ? { symbol, pair } : { symbol, pair: null };
});

const configResult = await rpc("eth_call", [{ to: DIAMOND, data: TRADING_CONFIG_SELECTOR }, "latest"]);
if (!configResult || configResult.length < 130) throw new Error("getTradingConfig returned too little data");
const minNotionalUsdRaw = asWord(configResult, 32).toString();

let hyperliquidXyzMeta = null;
let hyperliquidDefaultMeta = null;
const hyperliquidMetaErrors = [];
const hyperliquidPairs = selected.filter((x) => x.pair?.executionVenue === "HYPERLIQUID");
if (hyperliquidPairs.length) {
  try { hyperliquidXyzMeta = await hyperliquidMeta("xyz"); } catch (error) { hyperliquidMetaErrors.push("xyz DEX meta: " + String(error)); }
  try { hyperliquidDefaultMeta = await hyperliquidMeta(null); } catch (error) { hyperliquidMetaErrors.push("default meta: " + String(error)); }
}

const markets = await mapLimit(selected.filter((x) => x.pair), 4, async ({ symbol, pair }) => {
  const sourceMapMaxLeverage = sourceMap[symbol] ?? null;
  const stagingMapMaxLeverage = stagingMap[symbol] ?? null;
  if (pair.executionVenue === "HYPERLIQUID") {
    const universe = [
      ...(hyperliquidXyzMeta?.universe || []),
      ...(hyperliquidDefaultMeta?.universe || [])
    ];
    const asset = universe.find((item) => item.name === symbol);
    const maxLeverage = asset?.maxLeverage ?? null;
    return {
      symbol,
      pairName: pair.pairName,
      pairBase: pair.base || pair.baseAddress,
      apiStatus: pair.status,
      executionVenue: pair.executionVenue,
      verificationSource: "Hyperliquid public meta",
      sourceMapMaxLeverage,
      stagingMapMaxLeverage,
      verifiedMaxLeverage: maxLeverage,
      sourceMapMatches: maxLeverage === null ? null : maxLeverage === sourceMapMaxLeverage,
      stagingMapMatches: maxLeverage === null ? null : maxLeverage === stagingMapMaxLeverage,
      minHoldingSeconds: pair.minHoldingSeconds,
      error: maxLeverage === null ? "No matching asset in Hyperliquid meta (default or xyz DEX)" : null
    };
  }

  const base = pair.base || pair.baseAddress;
  if (!base || !/^0x[0-9a-fA-F]{40}$/.test(base)) {
    return { symbol, pairName: pair.pairName, error: "Missing/invalid pair base address", apiStatus: pair.status, executionVenue: pair.executionVenue };
  }
  const data = PAIR_SELECTOR + base.slice(2).toLowerCase().padStart(64, "0");
  try {
    const raw = await rpc("eth_call", [{ to: DIAMOND, data }, "latest"]);
    const decoded = decodePairView(raw);
    const maxLeverage = Math.max(0, ...decoded.leverageMargins.map((tier) => tier.maxLeverage));
    return {
      symbol,
      pairName: pair.pairName,
      pairBase: base,
      apiStatus: pair.status,
      executionVenue: pair.executionVenue,
      verificationSource: "LeverUp Diamond getPairByBaseV4",
      minHoldingSeconds: pair.minHoldingSeconds,
      onchainStatus: decoded.status,
      onchainName: decoded.name,
      sourceMapMaxLeverage,
      stagingMapMaxLeverage,
      verifiedMaxLeverage: maxLeverage || null,
      sourceMapMatches: maxLeverage === 0 ? null : maxLeverage === sourceMapMaxLeverage,
      stagingMapMatches: maxLeverage === 0 ? null : maxLeverage === stagingMapMaxLeverage,
      leverageMargins: decoded.leverageMargins,
      slippageConfig: decoded.slippageConfig,
      feeConfig: decoded.feeConfig,
      maxLongOiUsdRaw: decoded.maxLongOiUsdRaw,
      maxShortOiUsdRaw: decoded.maxShortOiUsdRaw,
      fundingFeePerBlockPRaw: decoded.fundingFeePerBlockPRaw,
      minFundingFeeRRaw: decoded.minFundingFeeRRaw,
      maxFundingFeeRRaw: decoded.maxFundingFeeRRaw,
      longHoldingFeeRateRaw: decoded.longHoldingFeeRateRaw,
      shortHoldingFeeRateRaw: decoded.shortHoldingFeeRateRaw,
      error: maxLeverage === 0 ? "Pair exists in REST API but no onchain leverage-margin tiers were returned" : null
    };
  } catch (error) {
    return {
      symbol,
      pairName: pair.pairName,
      pairBase: base,
      apiStatus: pair.status,
      executionVenue: pair.executionVenue,
      sourceMapMaxLeverage,
      stagingMapMaxLeverage,
      error: String(error)
    };
  }
});

const report = {
  checkedAt: new Date().toISOString(),
  chainId: "143",
  rpc: RPC,
  diamond: DIAMOND,
  pairApi: PAIRS_URL,
  pairApiTotal: pairsResponse.totalElements ?? allPairs.length,
  globalMinNotionalUsdRaw: minNotionalUsdRaw,
  globalMinNotionalUsd: Number(minNotionalUsdRaw) / 1e18,
  watchlist: WATCHLIST,
  missingPairs: selected.filter((x) => !x.pair).map((x) => x.symbol),
  markets,
  errors: markets.filter((x) => x.error).map((x) => ({ symbol: x.symbol, error: x.error })),
  hyperliquidMetaErrors,
  sourceMapMismatches: markets.filter((x) => x.sourceMapMatches === false).map((x) => ({
    symbol: x.symbol,
    sourceMapMaxLeverage: x.sourceMapMaxLeverage,
    verifiedMaxLeverage: x.verifiedMaxLeverage
  })),
  stagingMapMismatches: markets.filter((x) => x.stagingMapMatches === false).map((x) => ({
    symbol: x.symbol,
    stagingMapMaxLeverage: x.stagingMapMaxLeverage,
    verifiedMaxLeverage: x.verifiedMaxLeverage
  }))
};

await writeFile("leverup-market-tier-audit.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));

if (report.missingPairs.length || report.errors.length || report.stagingMapMismatches.length || markets.length !== WATCHLIST.length) {
  process.exitCode = 1;
}
