import { readFile, writeFile } from "node:fs/promises";
import vm from "node:vm";

const DIAMOND = "0xea1b8E4aB7f14F7dCA68c5B214303B13078FC5ec";
const RPC = process.env.LEVERUP_RPC_URL || "https://rpc.monad.xyz";
const PAIRS_URL = "https://service.leverup.xyz/v1/pairs?size=100&block_chain=MONAD";
const WATCHLIST = [
  "BTC", "ETH", "MON", "BNB", "XRP", "HYPE", "ONDO", "KPEPE", "QNT", "ZEC",
  "TRX", "AAVE", "ADA", "CASHCAT", "DOGE", "LINK", "LIT", "PONS", "PUMP",
  "SEI", "SOL", "SUI", "UNI", "VIRTUAL", "XMR"
];

const PAIR_SELECTOR = "0x9bd39764"; // getPairByBaseV4(address), from the verified PairsManagerFacet ABI
const TRADING_CONFIG_SELECTOR = "0x3569c2f7"; // getTradingConfig(), from the verified TradingConfigFacet ABI

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
  const tupleBase = asNumber(result, 0); // the single dynamic PairView tuple starts at this offset
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
  return { name, base, pairType, status, leverageMargins };
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

const markets = await mapLimit(selected.filter((x) => x.pair), 4, async ({ symbol, pair }) => {
  const base = pair.base || pair.baseAddress;
  if (!base || !/^0x[0-9a-fA-F]{40}$/.test(base)) {
    return { symbol, pairName: pair.pairName, error: "Missing/invalid pair base address", status: pair.status, executionVenue: pair.executionVenue };
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
      minHoldingSeconds: pair.minHoldingSeconds,
      onchainStatus: decoded.status,
      onchainName: decoded.name,
      maxLeverage,
      leverageMargins: decoded.leverageMargins
    };
  } catch (error) {
    return {
      symbol,
      pairName: pair.pairName,
      pairBase: base,
      apiStatus: pair.status,
      executionVenue: pair.executionVenue,
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
  errors: markets.filter((x) => x.error).map((x) => ({ symbol: x.symbol, error: x.error }))
};

await writeFile("leverup-market-tier-audit.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));

if (report.missingPairs.length || report.errors.length || markets.length !== WATCHLIST.length) {
  process.exitCode = 1;
}
