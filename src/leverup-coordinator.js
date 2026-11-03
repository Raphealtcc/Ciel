// Durable orchestration primitives. Entry submission intentionally remains hard-disabled.
import { evaluateLeverUpPortfolioRisk } from "./leverup-risk.js";
export async function prepareLeverUpExecution({ signal, preflight, account, portfolio, env, store, now = Date.now() }) {
  const signalId = String(signal?.id || "");
  if (!signalId) throw new Error("SIGNAL_ID_REQUIRED");
  if (!preflight || preflight.status !== "PREFLIGHT_PASS_LIVE_DISABLED") return { status: "REJECTED", signalId, reason: "PREFLIGHT_NOT_PASSED" };
  if (String(env?.LEVERUP_LIVE_TRADING).toLowerCase() !== "false" || String(env?.LEVERUP_KILL_SWITCH).toLowerCase() !== "true") return { status: "REJECTED", signalId, reason: "UNSAFE_EXECUTION_CONFIGURATION" };
  const risk = evaluateLeverUpPortfolioRisk({
    requestedLeverage: preflight.selectedLeverage || preflight.inferredLeverage,
    totalAllocationMon: env?.LEVERUP_TOTAL_ALLOCATION_MON ?? 50,
    reserveMon: env?.LEVERUP_RESERVE_MON ?? 25,
    availableWmonMon: account?.wmonBalanceMon,
    requestedMarginMon: preflight.marginMonUsed,
    entryBudgetMon: preflight.entryBudgetMon ?? preflight.marginMonUsed,
    currentOpenPositions: account?.openPositions || [],
    maxConcurrentPositions: env?.LEVERUP_MAX_CONCURRENT_POSITIONS ?? 1,
    proposedStopRiskMon: preflight.stopRiskMon,
    aggregateStopRiskMon: portfolio?.aggregateStopRiskMon ?? 0,
    maxAggregateStopRiskMon: env?.LEVERUP_MAX_AGGREGATE_STOP_RISK_MON ?? 1,
    dailyRealizedLossMon: portfolio?.dailyRealizedLossMon ?? 0,
    maxDailyRealizedLossMon: env?.LEVERUP_MAX_DAILY_LOSS_MON ?? 1,
    rollingDrawdownMon: portfolio?.rollingDrawdownMon ?? 0,
    maxRollingDrawdownMon: env?.LEVERUP_MAX_DRAWDOWN_MON ?? 2,
    staleFeed: Boolean(account?.staleFeed),
    executionUncertain: Boolean(account?.executionUncertain),
    killSwitchActive: String(env?.LEVERUP_KILL_SWITCH).toLowerCase() !== "false",
  });
  const record = { schemaVersion: 1, signalId, status: risk.allowed ? "DRY_RUN_APPROVED" : "REJECTED", createdAt: now, risk, preflight, liveSubmissionPerformed: false };
  if (store?.put) await store.put("ciel:leverup:execution:v1:" + signalId, JSON.stringify(record), { expirationTtl: 604800 });
  return record;
}
export async function reconcileLeverUpIntent({ intentHash, pollStatus, readPositions, previousState }) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(intentHash || ""))) throw new Error("INVALID_INTENT_HASH");
  const status = await pollStatus(intentHash);
  if (!status || (!status.executed && !status.skipped)) return { status: "PENDING", intentHash, previousState: previousState || null };
  const positions = await readPositions();
  return { status: status.skipped ? "SKIPPED" : "RECONCILED", intentHash, intentStatus: status, positions, reconciledAt: Date.now() };
}
