import {
  createLeverUpPublicClient,
  fetchLatestOraclePrices,
  fetchOpenPositions,
  fetchLeverUpPairs,
  readPositionsV4,
  readTokenBalancesAndAllowances,
  LEVERUP_TOKENS,
} from "./leverup-readonly.js";

const WMON = "0x3bd359c1119da7da1d913d1c4d2b7c461115433a";
const LVMON = LEVERUP_TOKENS.LVMON.toLowerCase();
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
function parseJson(value) {
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}
function strategyMode(payload) {
  const raw = String(payload?.candidate?.mode || payload?.candidate?.strategyMode || payload?.candidate?.strategy || payload?.mode || "").toUpperCase();
  if (raw.includes("TREND")) return "TREND_HOLD";
  return "OTHER";
}
function marginRawFromPayload(payload) {
  const raw = payload?.plan?.preflight?.marginRaw ?? payload?.plan?.preflight?.marginAmountRaw ??
    payload?.plan?.actionValues?.[4] ?? payload?.actionValues?.[4] ?? null;
  try { return raw == null ? null : BigInt(raw); } catch { return null; }
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
    const unrealizedUsdRaw = qty * signedDelta / PRICE_SCALE;
    result.push({
      hash,
      symbol: String(position.pair || item.symbol || item.pairName || "Unknown market"),
      side: position.isLong ? "LONG" : "SHORT",
      entryPriceRaw: entry.toString(),
      markPriceRaw: mark.toString(),
      qtyRaw: qty.toString(),
      unrealizedUsdRaw,
      marginToken: String(position.marginToken || "").toLowerCase(),
      marginRaw: String(position.margin || "0"),
    });
  }
  return result;
}

async function readLvmonUsdPrice(fetchImpl) {
  const pairs = await fetchLeverUpPairs({ fetchImpl });
  const lvmonPair = pairs.find((item) =>
    String(item.symbol || "").toUpperCase() === "LVMON" ||
    String(item.pairName || "").toUpperCase() === "LVMON/USD" ||
    String(item.pair || "").toUpperCase() === "LVMON/USD");
  // LVMON is 1:1 with MON. If LeverUp does not publish a dedicated LVMON/USD
  // market, value LVMON using the MON/USD oracle instead of failing the report.
  const monPair = lvmonPair || pairs.find((item) =>
    String(item.symbol || "").toUpperCase() === "MON" ||
    String(item.pairName || "").toUpperCase() === "MON/USD" ||
    String(item.pair || "").toUpperCase() === "MON/USD");
  const base = String(monPair?.base || monPair?.pairBase || "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(base)) throw new Error("LVMON_OR_MON_USD_ORACLE_PAIR_NOT_FOUND");
  const prices = await fetchLatestOraclePrices([base], { fetchImpl });
  return prices[base];
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
    WITH canonical_settlements AS (
      SELECT t.trade_id AS trade_id, t.position_hash, t.symbol, t.close_time,
        t.close_price_raw, t.net_pnl_after_fees_raw, t.source_json
      FROM leverup_trade_settlements t
      UNION ALL
      SELECT json_extract(r.source_json, '$.tradeId') AS trade_id,
        r.position_hash, r.symbol, r.close_time, r.close_price_raw,
        r.net_pnl_after_fees_raw, r.source_json
      FROM leverup_settlement_reconciliations r
      WHERE NOT EXISTS (
        SELECT 1 FROM leverup_trade_settlements t
        WHERE t.position_hash = r.position_hash AND t.close_time = r.close_time
      )
    )
    SELECT s.trade_id, s.position_hash, s.symbol, s.close_time, s.close_price_raw,
      s.net_pnl_after_fees_raw, s.source_json,
      COALESCE((SELECT f.margin_token FROM leverup_position_fee_snapshots f
        WHERE f.position_hash=s.position_hash ORDER BY f.observed_at_ms DESC LIMIT 1), 'UNKNOWN') AS margin_token,
      COALESCE(json_extract(s.source_json, '$.intentSignalId'), s.trade_id) AS signal_id,
      json_extract(s.source_json, '$.closeReason') AS close_reason,
      i.payload_json AS entry_payload_json
    FROM canonical_settlements s
    LEFT JOIN leverup_execution_intents i
      ON i.signal_id = COALESCE(json_extract(s.source_json, '$.intentSignalId'), s.trade_id)
    ORDER BY s.close_time DESC
  `).all();
  const settlements = rowsResult?.results || [];
  const attemptsResult = await env.DB.prepare(`
    SELECT signal_id, status, last_error, created_at_ms,
      COALESCE(json_extract(payload_json, '$.candidate.symbol'), json_extract(payload_json, '$.symbol')) AS symbol,
      json_extract(payload_json, '$.candidate.side') AS side
    FROM leverup_execution_intents
    WHERE action = 0
    ORDER BY created_at_ms DESC
    LIMIT 5
  `).all();
  const attempts = attemptsResult?.results || [];

  const realizedByToken = new Map();
  for (const row of settlements) {
    const token = String(row.margin_token || "UNKNOWN").toLowerCase();
    const item = realizedByToken.get(token) || { token, pnl: 0n, wins: 0, losses: 0, breakeven: 0, closed: 0 };
    const pnl = BigInt(row.net_pnl_after_fees_raw || "0");
    item.pnl += pnl;
    item.closed++;
    if (pnl > 0n) item.wins++;
    else if (pnl < 0n) item.losses++;
    else item.breakeven++;
    realizedByToken.set(token, item);
  }
  const lvmonStats = realizedByToken.get(LVMON) || { token: LVMON, pnl: 0n, wins: 0, losses: 0, breakeven: 0, closed: 0 };

  let open = [];
  let unrealizedError = null;
  let lvmonAvailableRaw = null;
  let balanceError = null;
  try {
    const balances = await readBalances(trader, [LEVERUP_TOKENS.LVMON], { publicClient });
    lvmonAvailableRaw = balances[LVMON]?.balance ?? null;
  } catch (error) { balanceError = String(error?.message || error).slice(0, 160); }
  try {
    open = await readOpenPositionsWithUnrealizedPnl({ trader, fetchImpl, publicClient });
  } catch (error) {
    unrealizedError = String(error?.message || error).slice(0, 180);
  }

  const openLvmon = open.filter((x) => x.marginToken === LVMON);
  const reservedLvmonRaw = openLvmon.reduce((sum, x) => sum + BigInt(x.marginRaw || "0"), 0n);
  let lvmonPriceRaw = null;
  let lvmonPriceError = null;
  let unrealizedLvmonRaw = null;
  if (!unrealizedError && openLvmon.length) {
    try {
      lvmonPriceRaw = await readLvmonUsdPrice(fetchImpl);
      unrealizedLvmonRaw = openLvmon.reduce((sum, x) => sum + (x.unrealizedUsdRaw * USD_SCALE / lvmonPriceRaw), 0n);
    } catch (error) { lvmonPriceError = String(error?.message || error).slice(0, 150); }
  } else if (!unrealizedError) unrealizedLvmonRaw = 0n;

  const nonLvmon = [...realizedByToken.values()].filter((x) => x.token !== LVMON);
  const totalPnlLvmonRaw = unrealizedLvmonRaw === null ? null : lvmonStats.pnl + unrealizedLvmonRaw;
  const equityLvmonRaw = lvmonAvailableRaw === null || unrealizedLvmonRaw === null
    ? null : lvmonAvailableRaw + reservedLvmonRaw + unrealizedLvmonRaw;
  const starterBalanceRaw = lvmonAvailableRaw;
  const returnPct = totalPnlLvmonRaw !== null && starterBalanceRaw !== null && starterBalanceRaw > 0n
    ? Number(totalPnlLvmonRaw) / Number(starterBalanceRaw) * 100 : null;

  const closedForStats = settlements.filter((row) => String(row.margin_token || "").toLowerCase() === LVMON);
  const strategyStats = { TREND_HOLD: [], OTHER: [] };
  for (const row of closedForStats) {
    const payload = parseJson(row.entry_payload_json);
    strategyStats[strategyMode(payload)].push(row);
  }
  const strategyLine = (label, rows) => {
    const wins = rows.filter((row) => BigInt(row.net_pnl_after_fees_raw || "0") > 0n).length;
    const losses = rows.filter((row) => BigInt(row.net_pnl_after_fees_raw || "0") < 0n).length;
    const pnl = rows.reduce((sum, row) => sum + BigInt(row.net_pnl_after_fees_raw || "0"), 0n);
    const rate = rows.length ? (wins / rows.length * 100).toFixed(1) + "%" : "n/a";
    return label + ": " + rows.length + " closed | " + wins + "W/" + losses + "L | win rate " + rate + " | realised " + signedUnits(pnl) + " LVMON";
  };

  const lines = [
    "🔴 CIEL LIVE TRADING — LEVERUP",
    "Starter balance: " + (starterBalanceRaw === null ? "UNAVAILABLE" + (balanceError ? " — " + balanceError : "") : formatUnits(starterBalanceRaw) + " LVMON (on-chain wallet balance)"),
    "Available balance: " + (lvmonAvailableRaw === null ? "UNAVAILABLE" : formatUnits(lvmonAvailableRaw) + " LVMON"),
    "Margin reserved in open trades: " + (unrealizedError ? "UNAVAILABLE" : formatUnits(reservedLvmonRaw) + " LVMON"),
    "Realised P&L: " + signedUnits(lvmonStats.pnl) + " LVMON",
    "Unrealised P&L: " + (unrealizedLvmonRaw === null ? "UNAVAILABLE" + (lvmonPriceError || unrealizedError ? " — " + (lvmonPriceError || unrealizedError) : "") : signedUnits(unrealizedLvmonRaw) + " LVMON"),
    "Total P&L: " + (totalPnlLvmonRaw === null ? "UNAVAILABLE" : signedUnits(totalPnlLvmonRaw) + " LVMON" + (returnPct === null ? "" : " (" + returnPct.toFixed(2) + "%)")),
    "Live equity: " + (equityLvmonRaw === null ? "UNAVAILABLE" : formatUnits(equityLvmonRaw) + " LVMON"),
    "Trades: " + (unrealizedError ? "open count unavailable" : open.length + " open") + " | " + lvmonStats.closed + " closed | " + lvmonStats.wins + " wins | " + lvmonStats.losses + " losses | " + lvmonStats.breakeven + " breakeven",
    "",
    "STRATEGY PERFORMANCE (CLOSED LIVE TRADES)",
    strategyLine("Trend holds", strategyStats.TREND_HOLD),
  ];
  if (strategyStats.OTHER.length) lines.push(strategyLine("Other / unclassified", strategyStats.OTHER));

  lines.push("", "OPEN LIVE TRADES");
  if (unrealizedError) {
    lines.push("UNAVAILABLE — " + unrealizedError);
  } else if (!open.length) {
    lines.push("No open live trades.");
  } else {
    for (const position of open.slice(0, 10)) {
      const pnl = position.marginToken === LVMON && unrealizedLvmonRaw !== null
        ? signedUnits(position.unrealizedUsdRaw * USD_SCALE / lvmonPriceRaw) + " LVMON"
        : signedUnits(position.unrealizedUsdRaw) + " USD";
      lines.push(position.side + " " + position.symbol + " | entry $" + (Number(position.entryPriceRaw) / 1e18).toFixed(6) +
        " | mark $" + (Number(position.markPriceRaw) / 1e18).toFixed(6) + " | unrealised " + pnl);
    }
  }

  lines.push("", "RECENT CLOSED TRADES");
  if (!settlements.length) {
    lines.push("No settled LeverUp trades have been reconciled into CIEL's settlement ledger yet.");
  } else {
    for (const row of settlements.slice(0, 5)) {
      const payload = parseJson(row.entry_payload_json);
      const candidate = payload.candidate || {};
      const side = String(candidate.side || "TRADE").toUpperCase();
      const mode = strategyMode(payload);
      const modeLabel = mode === "TREND_HOLD" ? "TREND HOLD" : "LEGACY";
      const reason = String(row.close_reason || parseJson(row.source_json).closeReason || "EXCHANGE_REPORTED_CLOSE");
      const token = String(row.margin_token || "UNKNOWN").toLowerCase();
      const decimals = token === "0x754704bc059f8c67012fed69bc8a327a5aafb603" ? 6 : 18;
      const pnl = BigInt(row.net_pnl_after_fees_raw || "0");
      const margin = marginRawFromPayload(payload);
      const roi = token === LVMON && margin && margin > 0n ? (Number(pnl) / Number(margin) * 100).toFixed(2) + "%" : "n/a";
      const pnlLabel = signedUnits(pnl, decimals) + " " + (token === LVMON ? "LVMON" : token === WMON ? "WMON" : token);
      lines.push(side + " " + row.symbol + " | " + modeLabel + " | " + reason + " | " + pnlLabel + " | " + roi);
    }
  }

  if (nonLvmon.length) {
    lines.push("", "OTHER COLLATERAL SETTLEMENTS (KEPT SEPARATE)");
    for (const item of nonLvmon) {
      const label = item.token === WMON ? "WMON" : item.token;
      const decimals = item.token === "0x754704bc059f8c67012fed69bc8a327a5aafb603" ? 6 : 18;
      lines.push(label + ": " + signedUnits(item.pnl, decimals) + " | " + item.closed + " closed | " + item.wins + "W/" + item.losses + "L");
    }
  }

  if (attempts.length) {
    lines.push("", "RECENT LIVE ENTRY ATTEMPTS — NOT COUNTED AS TRADES");
    for (const attempt of attempts) {
      const status = String(attempt.status || "UNKNOWN").toUpperCase();
      const outcome = status === "REJECTED" ? "FAILED — no position opened" :
        status === "UNCERTAIN" ? "OUTCOME UNCERTAIN — manual reconciliation required" :
        status === "SUBMITTED" || status === "PENDING" ? "AWAITING FINAL RECONCILIATION" :
        status === "EXECUTED" ? "EXECUTION RECONCILED — position/settlement tracked separately" : status;
      const label = [attempt.side, attempt.symbol].filter(Boolean).join(" ") || attempt.signal_id;
      const reason = attempt.last_error ? " — " + String(attempt.last_error).slice(0, 140) : "";
      lines.push(label + ": " + outcome + reason);
    }
  }
  lines.push("", "Live P&L uses LeverUp settlement records and on-chain/oracle marks. Realised P&L is net of recorded fees and funding/holding costs; unrealised P&L is gross before close fees and accrued carry. The starter balance line is the current on-chain LVMON wallet balance, not a historical opening-balance snapshot.");
  return lines.join("\n");
}
