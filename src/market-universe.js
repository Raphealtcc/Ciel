export const TEMPORARY_MARKET_ALLOWLIST = Object.freeze(["BTC", "ETH", "SOL", "BNB", "HYPE", "XRP", "ONDO", "KPEPE", "TRX", "AAVE", "ADA", "DOGE", "LINK", "PUMP", "SEI", "SUI", "UNI", "VIRTUAL"]);
const TEMPORARY_MARKET_SET = new Set(TEMPORARY_MARKET_ALLOWLIST);

export function isTemporaryMarketAllowed(symbol) {
  return TEMPORARY_MARKET_SET.has(String(symbol || "").trim().toUpperCase());
}

export function restrictTemporaryMarketUniverse(symbols) {
  return [...new Set((Array.isArray(symbols) ? symbols : []).map((symbol) => String(symbol || "").trim().toUpperCase()).filter(isTemporaryMarketAllowed))];
}
