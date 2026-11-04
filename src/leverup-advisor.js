import {
  LEVERUP_TOKENS, readLeverUpAccountSnapshot, selectLeverageTier,
  calculateMinimumCollateralMon, buildMarketOpenPlan, persistLeverUpPreflight,
} from "./leverup-readonly.js";
import { OneClickAction, signIntentDryRun } from "./leverup-1ct.js";
import { prepareLeverUpExecution, executeLeverUpEntry, verifyLeverUpCoordinatorDryRun } from "./leverup-coordinator.js";
import { inspectLeverUpTraderSigner } from "./leverup-approval.js";

const WMON = LEVERUP_TOKENS.WMON.toLowerCase();
const errorMessage = (error) => String(error?.message || error || "Unknown LeverUp preflight failure").slice(0, 220);
const monAmount = (raw) => { try { return (Number(BigInt(raw || "0")) / 1e18).toFixed(4); } catch { return "unavailable"; } };
const jsonSafe = (value) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));

export function leverUpCollateralUsdForLeverage({ leverage, minimumNotionalUsd, collateralAt50xUsd = 0.43, collateralAt100xUsd = 0.23 }) {
  const lev = Number(leverage), notional = Number(minimumNotionalUsd);
  const at50 = Number(collateralAt50xUsd), at100 = Number(collateralAt100xUsd);
  if (![lev, notional, at50, at100].every(Number.isFinite) || lev < 50 || notional <= 0 || at50 <= 0 || at100 <= 0) {
    throw new Error("LEVERUP_COLLATERAL_SCHEDULE_INPUT_INVALID");
  }
  const base = lev <= 50 ? at50 : lev >= 100 ? at100 : at50 + (at100 - at50) * ((lev - 50) / 50);
  return base * (notional / 20);
}

function accountSummary(snapshot) {
  const wmon = snapshot?.accountTokenStates?.[WMON], auth = snapshot?.agentAuthorization;
  return {
    wmonBalanceMon: wmon ? monAmount(wmon.balance) : "unavailable",
    wmonAllowanceMon: wmon ? monAmount(wmon.allowance) : "unavailable",
    agentAuthorized: Boolean(auth?.authorized), canMarketOpen: Boolean(auth?.canMarketOpen),
    canMarketClose: Boolean(auth?.canMarketClose), canPartialClose: Boolean(auth?.canPartialClose),
    openPositionCount: Array.isArray(snapshot?.indexedPositions) ? snapshot.indexedPositions.length : null,
    blockNumber: snapshot?.blockNumber || null,
  };
}

async function savePreflight(env, signalId, record) {
  if (env?.CIEL_STATE?.put) await env.CIEL_STATE.put(
    "ciel:leverup:preflight:v1:" + String(signalId),
    JSON.stringify(jsonSafe(record)), { expirationTtl: 86400 },
  ).catch((error) => console.error("LeverUp preflight KV persistence failed: " + errorMessage(error)));
}

export async function prepareLeverUpAdvisorPlan({
  env, candidate, reviewed, signalId, now = Date.now(), technicalOnly = false, dependencies = {},
}) {
  const [liveOverride, liveEntryOverride] = env?.CIEL_STATE && typeof env.CIEL_STATE.get === "function"
    ? await Promise.all([env.CIEL_STATE.get("ciel:control:live-enabled"), env.CIEL_STATE.get("ciel:control:live-entry-enabled")])
    : [null, null];
  const liveConfigured = String(liveOverride ?? env?.LEVERUP_LIVE_TRADING).toLowerCase() === "true";
  const liveMode = liveConfigured && liveEntryOverride !== "false" && String(env?.LEVERUP_KILL_SWITCH).toLowerCase() === "false";
  const dryRunMode = !liveConfigured && String(env?.LEVERUP_KILL_SWITCH).toLowerCase() === "true";
  const result = (status, reason, extra = {}) => ({
    schemaVersion: 1, signalId: String(signalId || ""),
    symbol: String(candidate?.symbol || "").toUpperCase(), status, reason, checkedAt: now,
    executionMode: liveMode ? "LIVE_GATED" : "DRY_RUN_ONLY",
    liveExecutionEnabled: liveMode, killSwitchEnabled: !liveMode, ...extra,
  });
  if (!candidate?.symbol) return result("BLOCKED", "CIEL candidate symbol is missing.");
  if (reviewed?.verdict !== "APPROVE" || technicalOnly) return result("NOT_APPROVED",
    "CIEL did not produce a fully confirmed APPROVE; LeverUp entry preflight was not attempted.");
  if (String(env?.LEVERUP_PREFLIGHT_ENABLED || "").toLowerCase() !== "true") return result("DISABLED",
    "LeverUp advisor preflight is not enabled in Worker configuration.");
  if (!dryRunMode && !liveMode) return result("BLOCKED_SAFETY_CONFIGURATION",
    "Execution flags must be exactly LIVE=false/KILL=true for dry-run or LIVE=true/KILL=false for explicitly enabled live execution.");

  const traderAddress = String(env?.LEVERUP_TRADER_ADDRESS || "");
  const agentAddress = String(env?.LEVERUP_AGENT_ADDRESS || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(traderAddress) || !/^0x[0-9a-fA-F]{40}$/.test(agentAddress)) {
    return result("BLOCKED_WALLET_CONFIGURATION", "Trader or agent public address is missing or invalid.");
  }
  const minimumLeverage = Number(env?.LEVERUP_MIN_LEVERAGE || 50);
  if (!Number.isFinite(minimumLeverage) || minimumLeverage < 50) return result("BLOCKED_LEVERAGE_POLICY",
    "Configured LeverUp minimum leverage is below 50x.");

  // The operator-provided venue minima are USD collateral amounts, not a protocol CR.
  // Derive an equivalent ratio after reading the live minimum notional and selected leverage.
  let collateralRatio = null;
  let snapshot;
  try {
    const readSnapshot = dependencies.readSnapshot || readLeverUpAccountSnapshot;
    snapshot = await readSnapshot({
      traderAddress, agentAddress, symbol: String(candidate.symbol).toUpperCase(), collateralRatio,
      rpcUrl: env?.LEVERUP_RPC_URL || "https://monad-mainnet.drpc.org",
      ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
    });
  } catch (error) {
    const blocked = result("BLOCKED_READ_ONLY_CHECK", errorMessage(error));
    await savePreflight(env, signalId, blocked);
    return blocked;
  }

  const account = accountSummary(snapshot);
  if (Array.isArray(snapshot.indexedPositions) && snapshot.indexedPositions.length > 0) {
    const blocked = result("BLOCKED_EXISTING_POSITION",
      "The trader already has an open LeverUp position. CIEL will not add exposure until it is reconciled or closed.", { account });
    await savePreflight(env, signalId, blocked); return blocked;
  }
  try {
    const tiers = snapshot.pairView?.leverageMargins || [];
    const marketMaxLeverage = Math.max(0, ...tiers.map((tier) => Number(tier.maxLeverage)));
    const minimumNotionalRaw = BigInt(snapshot.minimumNotionalRaw);
    const minimumTier = selectLeverageTier(tiers, minimumNotionalRaw);
    if (!minimumTier) throw new Error("NO_LEVERAGE_TIER_FOR_VENUE_MINIMUM");
    const inferredLeverage = Number(candidate.leverage ?? env?.LEVERUP_DEFAULT_LEVERAGE ?? (marketMaxLeverage >= 100 ? 100 : 50));
    if (!Number.isFinite(inferredLeverage) || inferredLeverage < 50) throw new Error("CIEL_INFERENCE_BELOW_50X");
    const leverageForMinimum = Math.min(inferredLeverage, Number(minimumTier.maxLeverage), marketMaxLeverage);
    if (leverageForMinimum < 50) throw new Error("MARKET_OR_NOTIONAL_TIER_BELOW_50X");

    const minimumNotionalUsd = Number(minimumNotionalRaw) / 1e18;
    const monUsdPrice = Number(snapshot.monUsdPriceRaw) / 1e18;
    const minimumCollateralUsd = leverUpCollateralUsdForLeverage({
      leverage: leverageForMinimum, minimumNotionalUsd,
      collateralAt50xUsd: env?.LEVERUP_COLLATERAL_50X_USD ?? 0.43,
      collateralAt100xUsd: env?.LEVERUP_COLLATERAL_100X_USD ?? 0.23,
    });
    collateralRatio = minimumNotionalUsd / (leverageForMinimum * minimumCollateralUsd);
    if (!(collateralRatio > 0 && collateralRatio <= 1)) throw new Error("DERIVED_COLLATERAL_RATIO_OUT_OF_RANGE");
    snapshot.collateralRatio = collateralRatio;
    const minimumMarginMon = minimumCollateralUsd / monUsdPrice;
    const totalAllocationMon = Number(env?.LEVERUP_TOTAL_ALLOCATION_MON || 50);
    const reserveMon = Number(env?.LEVERUP_RESERVE_MON ?? totalAllocationMon * 0.5);
    const allocationCeiling = Math.max(0, totalAllocationMon - reserveMon);
    const configuredTradeCeiling = Number(env?.LEVERUP_MAX_TRADE_MARGIN_MON);
    const maxTradeMarginMon = Number.isFinite(configuredTradeCeiling) && configuredTradeCeiling > 0
      ? Math.min(configuredTradeCeiling, allocationCeiling)
      : Math.min(minimumMarginMon, allocationCeiling);
    if (maxTradeMarginMon + 1e-9 < minimumMarginMon) throw new Error("VENUE_MINIMUM_MARGIN_EXCEEDS_CIEL_TRADE_ALLOCATION");
    const aiMargin = Number(reviewed?.liveMarginMon ?? env?.LEVERUP_MAX_TRADE_MARGIN_MON);
    const desiredMarginMon = Math.max(minimumMarginMon, Math.min(maxTradeMarginMon,
      Number.isFinite(aiMargin) && aiMargin > 0 ? aiMargin : minimumMarginMon));

    const expectedHoldSeconds = Math.max(0, Number(candidate.holdMinutes ??
      (candidate.mode === "RANGE_SCALP" ? 12 : candidate.mode === "CORE_PULLBACK_SCALP" ? 15 : 180)) * 60);
    const stopPct = Number(candidate.stopPct), targetPct = Number(candidate.targetPct);
    if (!(stopPct > 0 && targetPct > 0 && stopPct < 100 && targetPct < 100)) throw new Error("CIEL_STOP_OR_TARGET_INVALID");
    const stopBps = BigInt(Math.max(1, Math.round(stopPct * 100)));
    const targetBps = BigInt(Math.max(1, Math.round(targetPct * 100)));
    if (stopBps >= 10_000n || targetBps >= 10_000n) throw new Error("CIEL_STOP_OR_TARGET_OUT_OF_RANGE");
    const oracleRaw = BigInt(snapshot.oraclePriceRaw), isLong = candidate.side === "LONG";
    const stopLossPriceRaw = isLong ? oracleRaw * (10_000n - stopBps) / 10_000n : oracleRaw * (10_000n + stopBps) / 10_000n;
    const takeProfitPriceRaw = isLong ? oracleRaw * (10_000n + targetBps) / 10_000n : oracleRaw * (10_000n - targetBps) / 10_000n;

    const buildPlan = dependencies.buildPlan || buildMarketOpenPlan;
    const plan = buildPlan({ snapshot, desiredMarginMon, maxTradeMarginMon, inferredLeverage,
      side: candidate.side, expectedHoldSeconds, reserveMon, stopLossPriceRaw, takeProfitPriceRaw,
      requireExistingAllowance: false, now });
    const authorized = Boolean(snapshot.agentAuthorization?.authorized && snapshot.agentAuthorization?.canMarketOpen);
    const status = authorized ? (liveMode ? "PREFLIGHT_PASS_LIVE_ENABLED" : "PREFLIGHT_PASS_LIVE_DISABLED") : "BLOCKED_AGENT_AUTHORIZATION";
    const reason = authorized
      ? (liveMode
        ? "Live market, tier, margin, balance, fee, slippage and agent-open checks passed; entry is submitted only after idempotency, risk and exact allowance checks."
        : "Live market, tier, margin, balance and fee checks passed. Exact token approvals are prepared for live mode; no approval transaction or order was signed or submitted.")
      : "The agent wallet is not authorized for LeverUp market-open permission bit 0. No order was signed or submitted.";
    let ledgerId = null, ledgerPersisted = false;
    try {
      const persist = dependencies.persistPreflight || persistLeverUpPreflight;
      if (env?.DB?.prepare) {
        ledgerId = await persist(env.DB, signalId, plan.preflight, {
          decision: authorized ? "PASS" : "REJECT",
          rejectionReason: authorized ? null : "AGENT_MARKET_OPEN_PERMISSION_MISSING",
          blockNumber: snapshot.blockNumber,
        });
        ledgerPersisted = true;
      }
    } catch (error) { console.error("LeverUp preflight D1 ledger write failed: " + errorMessage(error)); }
    let dryRunSigning = { status: "NOT_CONFIGURED" };
    let coordination = { status: "NOT_RUN" };
    if (authorized && dryRunMode) {
      if (env?.LEVERUP_AGENT_PRIVATE_KEY) {
        try {
          dryRunSigning = await signIntentDryRun({
            env, traderAddress, agentAddress, agentAuthorization: snapshot.agentAuthorization,
            action: OneClickAction.MARKET_OPEN, nonce: plan.nonce, deadline: plan.deadline,
            actionValues: plan.actionValues, feeToken: plan.feeToken, antiDdosFee: plan.antiDdosFee,
            preflight: plan.preflight, now,
          });
        } catch (error) { dryRunSigning = { status: "FAILED", reason: errorMessage(error) }; }
      }
      try {
        const wmonBalanceMon = Number(BigInt(snapshot.accountTokenStates[WMON].balance)) / 1e18;
        const entryBudgetMon = Number(BigInt(plan.amountInRaw)) / 1e18;
        const stopRiskMon = Number(plan.marginMonUsed) * Number(plan.selectedLeverage) * stopPct / 100;
        coordination = await prepareLeverUpExecution({
          signal: { id: signalId },
          preflight: { status: "PREFLIGHT_PASS_LIVE_DISABLED", selectedLeverage: plan.selectedLeverage,
            inferredLeverage, marginMonUsed: plan.marginMonUsed, entryBudgetMon, stopRiskMon },
          account: { wmonBalanceMon, openPositions: snapshot.indexedPositions || [], staleFeed: false },
          portfolio: {}, env, store: env.CIEL_STATE, now,
        });
      } catch (error) { coordination = { status: "REJECTED", reason: errorMessage(error), risk: { reasons: ["PORTFOLIO_RISK_EVALUATION_FAILED"] } }; }
    }
    if (authorized && liveMode) {
      coordination = await executeLeverUpEntry({ env, db: env.DB, candidate, signalId, snapshot, plan, now, dependencies });
    }
    const record = result(status, reason, {
      account, ledgerId, ledgerPersisted, inferredLeverage, selectedLeverage: plan.selectedLeverage,
      tierMaxLeverage: plan.tierMaxLeverage, marginMonUsed: plan.marginMonUsed, notionalUsd: plan.notionalUsd,
      minimumMarginMon, reserveMon, maxTradeMarginMon, dryRunSigning, coordination,
      estimatedProtocolCosts: plan.preflight?.estimatedProtocolCosts || null,
      preflight: plan.preflight || null, plan: jsonSafe(plan),
    });
    await savePreflight(env, signalId, record); return record;
  } catch (error) {
    const blocked = result("BLOCKED_PREFLIGHT", errorMessage(error), { account });
    await savePreflight(env, signalId, blocked); return blocked;
  }
}

export function formatLeverUpAdvisorLine(record) {
  if (!record) return "LEVERUP: no preflight was generated.";
  const account = record.account || {};
  const accountLine = "WMON balance " + (account.wmonBalanceMon || "unavailable") +
    " MON; agent market-open permission " + (account.canMarketOpen ? "verified" : "not verified") + ".";
  const riskLine = record.coordination?.status === "REJECTED"
    ? "PORTFOLIO RISK BLOCKED — " + (record.coordination.risk?.reasons || []).join(", ") + "."
    : record.coordination?.status === "REJECTED_RISK"
      ? "LIVE ENTRY BLOCKED BY PORTFOLIO RISK — " + (record.coordination.reasons || []).join(", ") + "."
      : record.coordination?.status === "SUBMITTED"
        ? "LIVE INTENT SUBMITTED — " + String(record.coordination.intentHash || "hash pending") + "."
        : null;
  if (record.status === "PREFLIGHT_PASS_LIVE_DISABLED" || record.status === "PREFLIGHT_PASS_LIVE_ENABLED") {
    const costs = record.estimatedProtocolCosts || {};
    return [
      "LEVERUP PREFLIGHT: PASS — " + record.selectedLeverage + "x, margin " + Number(record.marginMonUsed).toFixed(3) +
        " MON, notional $" + Number(record.notionalUsd).toFixed(2) + ".",
      "Estimated open fee $" + Number(costs.openFeeUsd || 0).toFixed(4) +
        "; projected holding $" + Number(costs.holdingFeeUsd || 0).toFixed(4) +
        "; projected funding $" + Number(costs.fundingFeeUsd || 0).toFixed(4) + ".",
      accountLine,
      ...(riskLine ? [riskLine] : []),
      record.status === "PREFLIGHT_PASS_LIVE_ENABLED" ? "LIVE MODE — idempotent execution coordinator handled submission and reconciliation." : "DRY RUN ONLY — live trading is OFF; no order was signed or submitted.",
    ].join("\\n");
  }
  return "LEVERUP PREFLIGHT: " + record.status + " — " + String(record.reason || "No reason supplied") +
    " " + accountLine + " Live trading is OFF.";
}


export async function runLeverUpMarketPreflights({ env, traderAddress, agentAddress, now = Date.now(), dependencies = {}, baseSnapshot = null, symbols = ["BTC", "ETH", "SOL"] }) {
  const readSnapshot = dependencies.readMarketSnapshot || dependencies.readSnapshot || readLeverUpAccountSnapshot;
  const results = {};
  // Keep provider concurrency low. The public Monad RPC was rate-limiting the
  // previous three-way fan-out; reuse the already-read BTC snapshot as well.
  for (const symbol of symbols) {
    try {
      const snapshot = baseSnapshot && symbol === (baseSnapshot.market?.symbol || symbols[0]) ? { ...baseSnapshot } : await readSnapshot({
        traderAddress, agentAddress, symbol, collateralRatio: null,
        rpcUrl: env?.LEVERUP_RPC_URL || "https://monad-mainnet.drpc.org",
        ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
      });
      if (snapshot.market?.executionVenue === "HYPERLIQUID") throw new Error("MARKET_NOT_EXECUTED_BY_LEVERUP");
      const tiers = snapshot.pairView?.leverageMargins || [];
      const minimumNotionalRaw = BigInt(snapshot.minimumNotionalRaw || "0");
      const minimumTier = selectLeverageTier(tiers, minimumNotionalRaw);
      if (!minimumTier) throw new Error("NO_LEVERAGE_TIER_FOR_VENUE_MINIMUM");
      const marketMaxLeverage = Math.max(...tiers.map((tier) => Number(tier.maxLeverage)));
      const desiredLeverage = Number(env?.LEVERUP_DEFAULT_LEVERAGE || 100);
      const leverage = Math.min(desiredLeverage, Number(minimumTier.maxLeverage), marketMaxLeverage);
      if (!Number.isFinite(leverage) || leverage < 50) throw new Error("MARKET_OR_NOTIONAL_TIER_BELOW_50X");
      const minimumNotionalUsd = Number(minimumNotionalRaw) / 1e18;
      const monUsdPrice = Number(snapshot.monUsdPriceRaw) / 1e18;
      const minimumCollateralUsd = leverUpCollateralUsdForLeverage({
        leverage, minimumNotionalUsd,
        collateralAt50xUsd: env?.LEVERUP_COLLATERAL_50X_USD ?? 0.43,
        collateralAt100xUsd: env?.LEVERUP_COLLATERAL_100X_USD ?? 0.23,
      });
      const collateralRatio = minimumNotionalUsd / (leverage * minimumCollateralUsd);
      if (!(collateralRatio > 0 && collateralRatio <= 1) || !(monUsdPrice > 0)) throw new Error("LIVE_COLLATERAL_OR_ORACLE_DATA_INVALID");
      snapshot.collateralRatio = collateralRatio;
      const minimumMarginMon = minimumCollateralUsd / monUsdPrice;
      const totalAllocationMon = Number(env?.LEVERUP_TOTAL_ALLOCATION_MON || 50);
      const reserveMon = Number(env?.LEVERUP_RESERVE_MON ?? totalAllocationMon * 0.5);
      const allocationCeiling = Math.max(0, totalAllocationMon - reserveMon);
      const configuredTradeCeiling = Number(env?.LEVERUP_MAX_TRADE_MARGIN_MON);
      const maxTradeMarginMon = Number.isFinite(configuredTradeCeiling) && configuredTradeCeiling > 0
        ? Math.min(configuredTradeCeiling, allocationCeiling) : allocationCeiling;
      if (maxTradeMarginMon + 1e-9 < minimumMarginMon) throw new Error("VENUE_MINIMUM_MARGIN_EXCEEDS_CIEL_TRADE_ALLOCATION");
      const oracle = BigInt(snapshot.oraclePriceRaw);
      const buildPlan = dependencies.buildPlan || buildMarketOpenPlan;
      const plan = buildPlan({
        snapshot, desiredMarginMon: minimumMarginMon, maxTradeMarginMon,
        inferredLeverage: leverage, side: "LONG", expectedHoldSeconds: 900,
        reserveMon, stopLossPriceRaw: oracle * 9960n / 10_000n,
        takeProfitPriceRaw: oracle * 10_080n / 10_000n,
        requireExistingAllowance: false, now,
      });
      const wmon = snapshot.accountTokenStates?.[WMON] || {};
      const wmonAllowance = BigInt(wmon.allowance || "0");
      const wmonRequired = BigInt(plan.amountInRaw || "0");
      const feeToken = String(plan.feeToken || "0x0000000000000000000000000000000000000000").toLowerCase();
      const feeRequired = BigInt(plan.antiDdosFee || "0");
      const feeState = snapshot.accountTokenStates?.[feeToken] || {};
      const feeAllowance = BigInt(feeState.allowance || "0");
      const feeApprovalRequired = feeToken !== "0x0000000000000000000000000000000000000000" && feeRequired > 0n;
      const autoApprovalConfigured = String(env?.LEVERUP_AUTO_APPROVE).toLowerCase() === "true";
      const wmonAllowanceShortfall = wmonAllowance >= wmonRequired ? 0n : wmonRequired - wmonAllowance;
      const feeAllowanceShortfall = feeAllowance >= feeRequired ? 0n : feeRequired - feeAllowance;
      if (!autoApprovalConfigured && (wmonAllowanceShortfall > 0n || (feeApprovalRequired && feeAllowanceShortfall > 0n))) {
        throw new Error("TOKEN_ALLOWANCE_INSUFFICIENT_AND_AUTO_APPROVAL_DISABLED");
      }
      results[symbol] = {
        status: "PASS", symbol, pairBase: snapshot.market?.base || snapshot.market?.pairBase,
        marketStatus: snapshot.market?.status || null,
        executionVenue: snapshot.market?.executionVenue || null,
        selectedLeverage: leverage, marketMaxLeverage, minimumTierMaxLeverage: Number(minimumTier.maxLeverage),
        minimumNotionalUsd, minimumCollateralUsd, minimumMarginMon,
        plannedMarginMon: Number(plan.marginMonUsed), plannedNotionalUsd: Number(plan.notionalUsd),
        wmonBalanceMon: Number(BigInt(wmon.balance || "0")) / 1e18,
        wmonAllowanceRaw: wmonAllowance.toString(), wmonRequiredAllowanceRaw: wmonRequired.toString(),
        wmonAllowanceShortfallRaw: wmonAllowanceShortfall.toString(),
        feeToken, feeAllowanceRaw: feeAllowance.toString(), feeRequiredAllowanceRaw: feeRequired.toString(),
        feeAllowanceShortfallRaw: feeApprovalRequired ? feeAllowanceShortfall.toString() : "0",
        autoApprovalConfigured, approvalWillRunOnlyOnLiveEntry: true,
        orderSubmitted: false, approvalTransactionSubmitted: false,
        checkedAt: now, blockNumber: snapshot.blockNumber,
      };
    } catch (error) {
      results[symbol] = { status: "FAILED", symbol, reason: errorMessage(error), checkedAt: now, orderSubmitted: false };
    }
  }
  return results;
}

export async function runLeverUpDiagnostics({ env, now = Date.now(), dependencies = {}, symbols = ["BTC", "ETH", "SOL"], skipCoordinator = false }) {
  const traderAddress = String(env?.LEVERUP_TRADER_ADDRESS || "");
  const agentAddress = String(env?.LEVERUP_AGENT_ADDRESS || "");
  if (String(env?.LEVERUP_LIVE_TRADING).toLowerCase() !== "false" ||
      String(env?.LEVERUP_KILL_SWITCH).toLowerCase() !== "true") {
    return { ok: false, mode: "READ_ONLY_DRY_RUN", status: "BLOCKED_SAFETY_CONFIGURATION" };
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(traderAddress) || !/^0x[0-9a-fA-F]{40}$/.test(agentAddress)) {
    return { ok: false, mode: "READ_ONLY_DRY_RUN", status: "BLOCKED_WALLET_CONFIGURATION" };
  }
  const readSnapshot = dependencies.readSnapshot || readLeverUpAccountSnapshot;
  const snapshot = await readSnapshot({
    traderAddress, agentAddress, symbol: symbols[0] || "BTC", collateralRatio: null,
    rpcUrl: env?.LEVERUP_RPC_URL || "https://monad-mainnet.drpc.org",
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
  });
  const auth = snapshot.agentAuthorization || {};
  const keyConfigured = Boolean(String(env?.LEVERUP_AGENT_PRIVATE_KEY || "").trim());
  const traderSigning = inspectLeverUpTraderSigner({ env });
  let signing = { status: "NOT_TESTED", reason: "Signer key missing or agent lacks market-open permission." };
  if (keyConfigured && auth.authorized && auth.canMarketOpen === true) {
    try {
      const pairBase = String(snapshot.market?.base || snapshot.pairView?.base || "");
      if (!/^0x[0-9a-fA-F]{40}$/.test(pairBase)) throw new Error("LEVERUP_PAIR_BASE_INVALID");
      const signed = await signIntentDryRun({
        env, traderAddress, agentAddress, agentAuthorization: auth,
        action: OneClickAction.MARKET_OPEN,
        nonce: (BigInt(snapshot.lastAgentNonce || "0") + 1n).toString(),
        deadline: Math.floor(now / 1000) + 300,
        actionValues: [pairBase.toLowerCase(), true, LEVERUP_TOKENS.WMON, LEVERUP_TOKENS.LVMON,
          1n, 1n, 1n, 0n, 0n, 0, 0n],
        preflight: { preflightPassed: true, status: "AVAILABLE", requestedLeverage: 50,
          marketMaxLeverage: 50, maxLeverageForNotional: 50, checkedAt: now },
        now,
      });
      signing = { status: "PASS", syntheticSignOnly: true, signerAddress: signed.signerAddress,
        signatureDigest: signed.signatureDigest, intentDigest: signed.intentDigest };
    } catch (error) { signing = { status: "FAILED", reason: errorMessage(error) }; }
  }
  const tokenLabels = { WMON: LEVERUP_TOKENS.WMON, LVMON: LEVERUP_TOKENS.LVMON,
    USDC: LEVERUP_TOKENS.USDC, LVUSD: LEVERUP_TOKENS.LVUSD };
  const balancesAndAllowances = Object.fromEntries(Object.entries(tokenLabels).map(([label, token]) => {
    const state = snapshot.accountTokenStates?.[String(token).toLowerCase()];
    return [label, state ? { balanceRaw: state.balance, allowanceRaw: state.allowance } : null];
  }));
  const marketPreflights = dependencies.runMarketPreflights
    ? await dependencies.runMarketPreflights({ env, traderAddress, agentAddress, now })
    : await runLeverUpMarketPreflights({ env, traderAddress, agentAddress, now, dependencies, baseSnapshot: snapshot, symbols });
  const coordinator = skipCoordinator ? { status: "SKIPPED", orderSubmitted: false }
    : dependencies.verifyCoordinator
      ? await dependencies.verifyCoordinator({ env, db: env?.DB, now })
      : await verifyLeverUpCoordinatorDryRun({ env, db: env?.DB, now });
  const diagnosticsOk = traderSigning.status === "PASS" && signing.status === "PASS" &&
    Boolean(auth.authorized && auth.canMarketOpen && auth.canMarketClose && auth.canPartialClose) &&
    Object.values(balancesAndAllowances).every((value) => value !== null) &&
    Object.values(marketPreflights || {}).length === symbols.length &&
    Object.values(marketPreflights || {}).every((market) => market.status === "PASS") &&
    (skipCoordinator || coordinator?.status === "PASS");
  return jsonSafe({
    ok: diagnosticsOk, status: diagnosticsOk ? "READ_ONLY_CHECKS_PASS" : "READ_ONLY_CHECKS_INCOMPLETE",
    mode: "READ_ONLY_DRY_RUN", checkedAt: now, blockNumber: snapshot.blockNumber,
    traderWallet: traderAddress, agentWallet: agentAddress, traderSigning,
    traderSignerMatchesConfiguredWallet: traderSigning.matchesConfiguredTrader ?? false, signerKeyConfigured: keyConfigured,
    signerAddress: signing.signerAddress || null,
    signerMatchesConfiguredAgent: signing.signerAddress
      ? signing.signerAddress.toLowerCase() === agentAddress.toLowerCase() : null,
    balancesAndAllowances,
    nativeMonBalanceRaw: snapshot.nativeMonBalanceRaw ?? null,
    nativeMonBalanceMon: snapshot.nativeMonBalanceMon ?? null,
    nativeMonGasReady: Number(snapshot.nativeMonBalanceMon || 0) >= 0.02,
    indexedPositions: snapshot.indexedPositions || [],
    onchainPositions: snapshot.onchainPositions || [],
    agentAuthorization: {
      authorized: Boolean(auth.authorized), agentAddress: auth.agentAddress || null,
      canMarketOpen: Boolean(auth.canMarketOpen), canMarketClose: Boolean(auth.canMarketClose),
      canPartialClose: Boolean(auth.canPartialClose), authorizedAt: auth.authorizedAt || null,
    },
    lastAgentNonce: snapshot.lastAgentNonce || null, signing, marketPreflights, coordinator,
    liveTradingEnabled: false, killSwitchActive: true, orderSubmitted: false,
  });
}
