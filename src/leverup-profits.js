import {
  createLeverUpPublicClient,
  fetchLatestOraclePrices,
  fetchOpenPositions,
  readPositionsV4,
  readTokenBalancesAndAllowances,
  LEVERUP_TOKENS,
} from "./leverup-readonly.js";

const WMON = "0x3bd359c1119da7da1d913d1c4d2b7c461115433a";
const PRICE_SCALE = 10n ** 10n;
const USD_SCALE = 10n ** 18n;

function formatUnits(raw, decimals = 18) {
  const value = BigInt(raw || "0");
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const unit = 10n ** BigInt(decimals);
  const whole = absolute / unit;
  const fraction = (absolute % unit).toString().padStart(decimals, "0").slice(0, 4);
  return (negative ? "-" : "") + whole.toString() + "." + fraction;
}
function signedUnits(raw, decimals = 18) {
  const value = BigInt(raw || "0");
  return (value > 0n ? "+" : "") + formatUnits(value, decimals);
}
function getPositionHash(position) {
  return String(position?.positionHash || position?.position_hash || position?.hash || "").toLowerCase();
}
function getPairBase(position) {
  return String(position?.pairBase || position?.pair_base || position?.pair?.base || "").toLowerCase();
}

async function readOpenPositionsWithUnrealizedPnl({ trader, fetchImpl, publicClient }) {
  const indexed = await fetchOpenPositions(trader, { fetchImpl });
  if (!indexed.length) return [];
  const pairBases = [...new Set(indexed.map(getPairBase))];
  if (pairBases.some((base) => !/^0x[0-9a-f]{40}$/.test(base))) {
    throw new Error("LEVERUP_OPEN_POSITION_PAIR_BASE_MISSING");
  }
  const [prices, onchainGroups] = await Promise.all([
    fetchLatestOraclePrices(pairBases, { fetchImpl }),
    Promise.all(pairBases.map((base) => readPositionsV4(trader, base, { publicClient }))),
  ]);
  const onchain = onchainGroups.flat();
  const result = [];
  for (const item of indexed) {
    const hash = getPositionHash(item);
    if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error("LEVERUP_OPEN_POSITION_HASH_MISSING");
    const base = getPairBase(item);
    const position = onchain.find((candidate) => getPositionHash(candidate) === hash);
    if (!position) throw new Error("LEVERUP_OPEN_POSITION_NOT_FOUND_ONCHAIN: " + hash);
    const qty = BigInt(position.qty);
    const entry = BigInt(position.entryPrice);
    const mark = prices[base];
    if (qty <= 0n || entry <= 0n || mark <= 0n) throw new Error("LEVERUP_OPEN_POSITION_PRICE_OR_QTY_INVALID");
    const signedDelta = (position.isLong ? 1n : -1n) * (mark - entry);
    // LeverUp's execution builder uses qtyRaw = notionalUsdRaw * 1e10 / priceRaw.
    // Therefore qtyRaw * priceDeltaRaw / 1e10 is USD P&L in 18-decimal raw units.
    const unrealizedUsdRaw = qty * signedDelta / PRICE_SCALE;
    result.push({
      hash,
      symbol: String(position.pair || item.symbol || item.pairName || "Unknown market"),
      side: position.isLong ? "LONG" : "SHORT",
      entryPriceRaw: entry.toString(),
      markPriceRaw: mark.toString(),
      qtyRaw: qty.toString(),
      unrealizedUsdRaw,
      marginToken: String(position.marginToken || ""),
      marginRaw: String(position.margin || "0"),
    });
  }
  return result;
}

export async function buildLeverUpProfitReport({
  env,
  fetchImpl = fetch,
  publicClient = createLeverUpPublicClient(env?.LEVERUP_RPC_URL || "https://rpc2.monad.xyz"),
  readBalances = readTokenBalancesAndAllowances,
}) {
  const trader = String(env?.LEVERUP_TRADER_ADDRESS || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(trader)) throw new Error("LEVERUP_TRADER_ADDRESS_MISSING_OR_INVALID");
  if (!env?.DB?.prepare) throw new Error("LEVERUP_PROFITS_D1_UNAVAILABLE");

  const rowsResult = await env.DB.prepare(`
    SELECT s.position_hash, s.symbol, s.close_time, s.net_pnl_after_fees_raw,
      COALESCE((SELECT f.margin_token FROM leverup_position_fee_snapshots f
        WHERE f.position_hash=s.position_hash ORDER BY f.observed_at_ms DESC LIMIT 1), 'UNKNOWN') AS margin_token
    FROM leverup_settlement_reconciliations s
    ORDER BY s.close_time DESC
  `).all();
  const settlements = rowsResult?.results || [];
  const attemptsResult = await env.DB.prepare(`
    SELECT signal_id, status, last_error, created_at_ms,
      COALESCE(json_extract(payload_json, '$.symbol'), json_extract(payload_json, '$.candidate.symbol')) AS symbol,
      json_extract(payload_json, '$.candidate.side') AS side
    FROM leverup_execution_intents
    WHERE action = 0
    ORDER BY created_at_ms DESC
    LIMIT 5
  `).all();
  const attempts = attemptsResult?.results || [];
  const grouped = new Map();
  for (const row of settlements) {
    const token = String(row.margin_token || "UNKNOWN").toLowerCase();
    const item = grouped.get(token) || { token, pnl: 0n, wins: 0, losses: 0, closed: 0 };
    const pnl = BigInt(row.net_pnl_after_fees_raw || "0");
    item.pnl += pnl;
    item.closed++;
    if (pnl > 0n) item.wins++;
    else if (pnl < 0n) item.losses++;
    grouped.set(token, item);
  }

  let open = [];
  let unrealizedError = null;
  let lvmonAvailableRaw = null;
  let balanceError = null;
  try {
    const balances = await readBalances(trader, [LEVERUP_TOKENS.LVMON], { publicClient });
    lvmonAvailableRaw = balances[LEVERUP_TOKENS.LVMON.toLowerCase()]?.balance ?? null;
  } catch (error) { balanceError = String(error?.message || error).slice(0, 160); }
  try {
    open = await readOpenPositionsWithUnrealizedPnl({ trader, fetchImpl, publicClient });
  } catch (error) {
    unrealizedError = String(error?.message || error).slice(0, 180);
  }
  const totalUnrealizedUsdRaw = open.reduce((sum, position) => sum + position.unrealizedUsdRaw, 0n);
  const lines = [
    "🔴 CIEL LIVE TRADING — LEVERUP",
    "Account: " + trader,
    "Settled trades: " + settlements.length + " reconciled" + (unrealizedError ? " | open-position count unavailable" : " | " + open.length + " currently open"),
    "Configured starting live allocation: 70.0000 LVMON (reference amount, not a verified opening balance)",
    "Available LVMON wallet balance: " + (lvmonAvailableRaw === null ? "UNAVAILABLE" + (balanceError ? " — " + balanceError : "") : formatUnits(lvmonAvailableRaw, 18) + " LVMON"),
    "Open LVMON margin reserved: " + (unrealizedError ? "UNAVAILABLE" : formatUnits(open.filter((x) => x.marginToken.toLowerCase() === LEVERUP_TOKENS.LVMON.toLowerCase()).reduce((sum, x) => sum + BigInt(x.marginRaw || "0"), 0n), 18) + " LVMON"),
  ];
  if (grouped.size) {
    lines.push("", "REALIZED NET P&L — AFTER RECORDED FEES / FUNDING");
    for (const item of grouped.values()) {
      const label = item.token === "unknown" ? "Margin token not recorded" :
        item.token === WMON ? "WMON (MON)" : item.token;
      const decimals = item.token === "0x754704bc059f8c67012fed69bc8a327a5aafb603" ? 6 : 18;
      lines.push(label + ": " + signedUnits(item.pnl, decimals) + " token units | " + item.closed + " settled | " + item.wins + " wins / " + item.losses + " losses");
    }
  } else {
    lines.push("", "Realized P&L: no settled LeverUp trades have been reconciled into CIEL's settlement ledger yet.");
  }
  lines.push("", "RECENT LIVE ENTRY ATTEMPTS — NOT COUNTED AS TRADES");
  if (attempts.length) {
    for (const attempt of attempts) {
      const status = String(attempt.status || "UNKNOWN").toUpperCase();
      const outcome = status === "REJECTED" ? "FAILED — no position opened" :
        status === "UNCERTAIN" ? "OUTCOME UNCERTAIN — manual reconciliation required" :
        status === "SUBMITTED" || status === "PENDING" ? "AWAITING FINAL RECONCILIATION" :
        status === "EXECUTED" ? "EXECUTION RECONCILED — position/settlement tracked separately" :
        status;
      const label = [attempt.side, attempt.symbol].filter(Boolean).join(" ") || attempt.signal_id;
      const reason = attempt.last_error ? " — " + String(attempt.last_error).slice(0, 140) : "";
      lines.push(label + ": " + outcome + reason);
    }
  } else {
    lines.push("No LeverUp entry attempts recorded.");
  }

  lines.push("", "UNREALIZED P&L — LIVE ORACLE MARK, GROSS BEFORE CLOSE FEES / FUNDING");
  if (unrealizedError) {
    lines.push("UNAVAILABLE — " + unrealizedError);
  } else if (open.length) {
    lines.push("Open positions: " + open.length);
    lines.push("Total gross unrealized: " + signedUnits(totalUnrealizedUsdRaw) + " USD");
    for (const position of open.slice(0, 10)) {
      lines.push(position.side + " " + position.symbol + ": " + signedUnits(position.unrealizedUsdRaw) + " USD");
    }
  } else {
    lines.push("Open positions: 0", "No open LeverUp positions were returned by the exchange.");
  }
  lines.push("", "Unrealized values use LeverUp on-chain position quantity/entry and the latest LeverUp oracle mark. They are gross estimates, not settlement values; close fees and accrued funding/holding costs are excluded. Realized P&L is reported separately in each margin token and is not combined across assets.");
  return lines.join("\n");
}
