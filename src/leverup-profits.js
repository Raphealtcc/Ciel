import { fetchAllPositionsPaginated } from "./leverup-readonly.js";

const fmtToken = (raw, decimals = 18) => {
  try {
    const value = BigInt(raw || "0");
    const unit = 10n ** BigInt(decimals);
    const whole = value / unit;
    const fraction = (value < 0n ? -value : value) % unit;
    return (value < 0n ? "-" : "") + whole.toString() + "." + fraction.toString().padStart(decimals, "0").slice(0, 4);
  } catch { return "unavailable"; }
};
const signed = (value) => (value > 0n ? "+" : "") + fmtToken(value.toString()) ;

export async function buildLeverUpProfitReport({ env, fetchImpl = fetch }) {
  const trader = String(env?.LEVERUP_TRADER_ADDRESS || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(trader)) throw new Error("LEVERUP_TRADER_ADDRESS_MISSING_OR_INVALID");
  if (!env?.DB?.prepare) throw new Error("LEVERUP_PROFITS_D1_UNAVAILABLE");

  // The coordinator records settled, fee-reconciled results from LeverUp's closed-position history.
  const rowsResult = await env.DB.prepare(`
    SELECT s.position_hash, s.symbol, s.close_time, s.net_pnl_after_fees_raw,
      COALESCE((SELECT f.margin_token FROM leverup_position_fee_snapshots f
        WHERE f.position_hash=s.position_hash ORDER BY f.observed_at_ms DESC LIMIT 1), 'UNKNOWN') AS margin_token
    FROM leverup_settlement_reconciliations s
    ORDER BY s.close_time DESC LIMIT 500
  `).all();
  const settlements = rowsResult?.results || [];
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

  // Fetch the exchange's own current position list. Do not infer unrealised P&L from CIEL's paper marks.
  const positions = await fetchAllPositionsPaginated(trader, { fetchImpl, size: 100, maxPages: 10 });
  const open = positions.filter((p) => String(p?.status || "").toUpperCase() === "OPEN");
  const lines = [
    "🔴 CIEL LIVE TRADING — LEVERUP",
    "Account: " + trader,
    "Settled trades: " + settlements.length + " reconciled | " + open.length + " currently open",
  ];
  if (grouped.size) {
    lines.push("", "REALIZED NET P&L — AFTER RECORDED FEES / FUNDING");
    for (const item of grouped.values()) {
      const label = item.token === "unknown" ? "Margin token not recorded" :
        item.token === "0x3bd359c1119da7da1d913d1c4d2b7c461115433a" ? "WMON (MON)" : item.token;
      lines.push(label + ": " + signed(item.pnl) + " token units | " + item.closed + " settled | " + item.wins + " wins / " + item.losses + " losses");
    }
  } else {
    lines.push("", "Realized P&L: no settled LeverUp trades have been reconciled into CIEL's settlement ledger yet.");
  }
  lines.push("", "Unrealized P&L: not reported by this summary. Open positions are listed from LeverUp history; no paper marks are substituted.");
  if (open.length) {
    lines.push("", "OPEN LIVE POSITIONS");
    for (const p of open.slice(0, 10)) {
      const symbol = String(p.symbol || p.pairName || p.pair?.name || "Unknown market");
      const side = p.isLong === true || String(p.side || "").toUpperCase() === "LONG" ? "LONG" :
        p.isLong === false || String(p.side || "").toUpperCase() === "SHORT" ? "SHORT" : "SIDE UNKNOWN";
      lines.push(side + " " + symbol + " | position " + String(p.positionHash || p.id || "unavailable"));
    }
  }
  lines.push("", "Live figures only. Settled P&L is included after CIEL's LeverUp settlement reconciliation; token groups are kept separate and are not added across different assets.");
  return lines.join("\n");
}
