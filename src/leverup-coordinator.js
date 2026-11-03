// Durable, idempotent LeverUp 1CT execution and position lifecycle.
import { evaluateLeverUpPortfolioRisk } from "./leverup-risk.js";
import {
  LEVERUP_1CT, OneClickAction, getIntentStatusOnce, selectFeeToken, signAndSubmitIntent,
} from "./leverup-1ct.js";
import { ensureLeverUpTokenAllowance } from "./leverup-approval.js";
import {
  LEVERUP_TOKENS, createLeverUpPublicClient, fetchOpenPositions, fetchAllPositionsPaginated,
  fetchLatestOraclePrices, fetchAntiDdosConfig, readPositionsV4, normalizePositionAccrual,
  readPairByBaseV4, readTokenBalancesAndAllowances, readAgentAuthorization, readLastAgentNonce,
  persistPositionFeeSnapshot, reconcileClosedPosition, persistSettlementReconciliation,
} from "./leverup-readonly.js";

const WMON = LEVERUP_TOKENS.WMON.toLowerCase();
const ZERO = LEVERUP_1CT.zeroAddress;
const serializable = (value) => JSON.parse(JSON.stringify(value, (_k, v) => typeof v === "bigint" ? v.toString() : v));
const liveEnabled = (env) => String(env?.LEVERUP_LIVE_TRADING).toLowerCase() === "true" &&
  String(env?.LEVERUP_KILL_SWITCH).toLowerCase() === "false";

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
    killSwitchActive: false,
  });
  const record = { schemaVersion: 1, signalId, status: risk.allowed ? "DRY_RUN_APPROVED" : "REJECTED", createdAt: now, risk, preflight, liveSubmissionPerformed: false };
  if (store?.put) await store.put("ciel:leverup:execution:v1:" + signalId, JSON.stringify(record), { expirationTtl: 604800 });
  return record;
}

async function updateIntent(db, signalId, status, patch = {}) {
  const sets = ["status = ?", "updated_at_ms = ?"];
  const values = [status, Date.now()];
  if (patch.intentHash !== undefined) { sets.push("intent_hash = ?"); values.push(patch.intentHash); }
  if (patch.lastError !== undefined) { sets.push("last_error = ?"); values.push(patch.lastError); }
  if (patch.payload !== undefined) { sets.push("payload_json = ?"); values.push(JSON.stringify(serializable(patch.payload))); }
  values.push(signalId);
  await db.prepare("UPDATE leverup_execution_intents SET " + sets.join(", ") + " WHERE signal_id = ?")
    .bind(...values).run();
}

async function claimIntent(db, { signalId, action, pairBase, leverage, marginMon, notionalUsd, payload, now }) {
  if (!db?.prepare) throw new Error("LEVERUP_D1_LEDGER_UNAVAILABLE");
  const idempotencyKey = "ciel:leverup:1ct:" + signalId;
  const inserted = await db.prepare(`INSERT OR IGNORE INTO leverup_execution_intents
    (signal_id,idempotency_key,status,pair_base,action,requested_leverage,margin_mon,notional_usd,payload_json,created_at_ms,updated_at_ms)
    VALUES (?,?, 'PREPARED', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(signalId,idempotencyKey,pairBase || null,action,leverage || null,marginMon || null,notionalUsd || null,
      JSON.stringify(serializable(payload)),now,now).run();
  const row = await db.prepare("SELECT * FROM leverup_execution_intents WHERE signal_id = ?").bind(signalId).first();
  return { created: Number(inserted?.meta?.changes || 0) === 1, row };
}

/**
 * Exactly-once safety is achieved by claiming the unique D1 signal key before POST.
 * If a request becomes ambiguous after the claim, it is marked UNCERTAIN and is never
 * resubmitted automatically. This prefers a manual reconciliation over a duplicate order.
 */
export async function submitLeverUpIntent({
  env, db, signalId, action, actionValues, traderAddress, agentAddress, agentAuthorization,
  nonce, deadline, feeToken = ZERO, antiDdosFee = 0n, preflight = null,
  allowanceRequirements = [], pairBase = null, leverage = null, marginMon = null,
  notionalUsd = null, payload = {}, now = Date.now(), dependencies = {},
}) {
  if (!liveEnabled(env)) return { status: "LIVE_DISABLED", submitted: false };
  if (!signalId || !Number.isInteger(Number(action))) throw new Error("LEVERUP_INTENT_INPUT_INVALID");
  const claim = await claimIntent(db, { signalId, action, pairBase, leverage, marginMon, notionalUsd,
    payload: { ...payload, action, actionValues: serializable(actionValues), feeToken, antiDdosFee: String(antiDdosFee) }, now });
  if (!claim.created) return { status: claim.row?.status || "DUPLICATE", duplicate: true, intentHash: claim.row?.intent_hash || null };

  let markedUncertain = false;
  try {
    const approval = dependencies.ensureAllowance || ensureLeverUpTokenAllowance;
    const grouped = new Map();
    for (const item of allowanceRequirements) {
      const token = String(item.tokenAddress || "").toLowerCase();
      if (!token || token === ZERO.toLowerCase() || BigInt(item.amount || 0) <= 0n) continue;
      grouped.set(token, (grouped.get(token) || 0n) + BigInt(item.amount));
    }
    for (const [tokenAddress, amount] of grouped) {
      await approval({ env, tokenAddress, requiredAmount: amount,
        ...(dependencies.approvalClients || {}) });
    }
    await updateIntent(db, signalId, "UNCERTAIN", { payload: { ...payload, action, actionValues: serializable(actionValues), submissionStartedAt: now } });
    markedUncertain = true;
    const submit = dependencies.submit || signAndSubmitIntent;
    const result = await submit({
      enabled: true, killSwitchActive: false, traderAddress, agentAddress, agentAuthorization,
      signerPrivateKey: env.LEVERUP_AGENT_PRIVATE_KEY, action, nonce, deadline, actionValues,
      feeToken, antiDdosFee, preflight, fetchImpl: dependencies.fetchImpl,
    });
    await updateIntent(db, signalId, "SUBMITTED", { intentHash: result.intentHash,
      payload: { ...payload, action, actionValues: serializable(actionValues), intentDigest: result.intent?.actionDataHash || null } });
    return { status: "SUBMITTED", submitted: true, intentHash: result.intentHash, signalId };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 300);
    await updateIntent(db, signalId, markedUncertain ? "UNCERTAIN" : "REJECTED", { lastError: message });
    return { status: markedUncertain ? "UNCERTAIN" : "REJECTED", submitted: false, signalId, reason: message };
  }
}

export async function executeLeverUpEntry({ env, db, candidate, signalId, snapshot, plan, now = Date.now(), dependencies = {} }) {
  if (!liveEnabled(env)) return { status: "LIVE_DISABLED", submitted: false };
  if (!snapshot?.agentAuthorization?.authorized || !snapshot.agentAuthorization.canMarketOpen) {
    return { status: "REJECTED", reason: "AGENT_MARKET_OPEN_PERMISSION_MISSING" };
  }
  const wmonBalance = Number(BigInt(snapshot.accountTokenStates?.[WMON]?.balance || "0")) / 1e18;
  const margin = Number(plan.marginMonUsed);
  const entryBudget = Number(BigInt(plan.amountInRaw)) / 1e18;
  const stopPct = Number(candidate.stopPct);
  const stopRiskMon = margin * Number(plan.selectedLeverage) * stopPct / 100;
  const risk = evaluateLeverUpPortfolioRisk({
    requestedLeverage: plan.selectedLeverage,
    totalAllocationMon: env.LEVERUP_TOTAL_ALLOCATION_MON ?? 50,
    reserveMon: env.LEVERUP_RESERVE_MON ?? 25,
    availableWmonMon: wmonBalance, requestedMarginMon: margin, entryBudgetMon: entryBudget,
    currentOpenPositions: snapshot.indexedPositions || [],
    maxConcurrentPositions: env.LEVERUP_MAX_CONCURRENT_POSITIONS ?? 1,
    proposedStopRiskMon: stopRiskMon, aggregateStopRiskMon: 0,
    maxAggregateStopRiskMon: env.LEVERUP_MAX_AGGREGATE_STOP_RISK_MON ?? 1,
    dailyRealizedLossMon: 0, maxDailyRealizedLossMon: env.LEVERUP_MAX_DAILY_LOSS_MON ?? 1,
    rollingDrawdownMon: 0, maxRollingDrawdownMon: env.LEVERUP_MAX_DRAWDOWN_MON ?? 2,
    staleFeed: now - Number(snapshot.checkedAt || now) > 30_000, executionUncertain: false, killSwitchActive: false,
  });
  if (!risk.allowed) return { status: "REJECTED_RISK", reasons: risk.reasons, risk };
  const feeToken = String(plan.feeToken || ZERO);
  const allowances = [{ tokenAddress: LEVERUP_TOKENS.WMON, amount: BigInt(plan.amountInRaw) }];
  if (feeToken.toLowerCase() !== ZERO.toLowerCase() && BigInt(plan.antiDdosFee || 0) > 0n) {
    allowances.push({ tokenAddress: feeToken, amount: BigInt(plan.antiDdosFee) });
  }
  const result = await submitLeverUpIntent({
    env, db, signalId, action: OneClickAction.MARKET_OPEN, actionValues: plan.actionValues,
    traderAddress: snapshot.traderAddress, agentAddress: snapshot.agentAddress,
    agentAuthorization: snapshot.agentAuthorization, nonce: plan.nonce, deadline: plan.deadline,
    feeToken, antiDdosFee: plan.antiDdosFee, preflight: plan.preflight,
    allowanceRequirements: allowances, pairBase: snapshot.market.base,
    leverage: plan.selectedLeverage, marginMon: plan.marginMonUsed, notionalUsd: plan.notionalUsd,
    payload: { symbol: candidate.symbol, candidate, plan: serializable(plan), stopRiskMon }, now, dependencies,
  });
  return { ...result, risk };
}

export async function reconcileLeverUpIntent({ intentHash, pollStatus, readPositions, previousState }) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(intentHash || ""))) throw new Error("INVALID_INTENT_HASH");
  const status = await pollStatus(intentHash);
  if (!status || (!status.executed && !status.skipped)) return { status: "PENDING", intentHash, previousState: previousState || null };
  const positions = await readPositions();
  return { status: status.skipped ? "SKIPPED" : "RECONCILED", intentHash, intentStatus: status, positions, reconciledAt: Date.now() };
}

export function evaluateLeverUpPositionAction({ position, currentPriceRaw, now = Date.now(), maxHoldMinutes = 180, partialTakeProfits = [], completedPartialLevels = [] }) {
  if (!position?.positionHash || !position?.qtyRaw) throw new Error("LEVERUP_POSITION_FIELDS_MISSING");
  const price = BigInt(currentPriceRaw), entry = BigInt(position.entryPriceRaw || 0);
  const stop = BigInt(position.stopLossRaw || 0), target = BigInt(position.takeProfitRaw || 0);
  const earliest = BigInt(position.earliestCloseTime || 0);
  const nowSeconds = BigInt(Math.floor(now / 1000));
  const isLong = Boolean(position.isLong);
  const stopHit = stop > 0n && (isLong ? price <= stop : price >= stop);
  const targetHit = target > 0n && (isLong ? price >= target : price <= target);
  const expired = Number.isFinite(Number(maxHoldMinutes)) && Number(maxHoldMinutes) > 0 &&
    now >= Number(position.timestamp || 0) * 1000 + Number(maxHoldMinutes) * 60_000;
  if (earliest > nowSeconds) return { action: "WAIT", reason: "MINIMUM_HOLD_NOT_REACHED" };
  if (stopHit) return { action: "MARKET_CLOSE", reason: "STOP_LOSS_TRIGGERED" };
  if (targetHit) return { action: "MARKET_CLOSE", reason: "TAKE_PROFIT_TRIGGERED" };
  if (expired) return { action: "MARKET_CLOSE", reason: "MAX_HOLD_TIME_REACHED" };
  if (entry > 0n) {
    for (let i = 0; i < partialTakeProfits.length; i++) {
      if (completedPartialLevels.includes(i)) continue;
      const level = partialTakeProfits[i] || {};
      const targetPct = Number(level.targetPct), closePct = Number(level.closePct ?? level.percent);
      if (!(targetPct > 0 && closePct > 0 && closePct < 100)) continue;
      const delta = BigInt(Math.round(targetPct * 100));
      const partialTarget = isLong ? entry * (10_000n + delta) / 10_000n : entry * (10_000n - delta) / 10_000n;
      if (isLong ? price >= partialTarget : price <= partialTarget) {
        const qty = BigInt(position.qtyRaw) * BigInt(Math.round(closePct * 100)) / 10_000n;
        if (qty > 0n && qty < BigInt(position.qtyRaw)) return { action: "PARTIAL_CLOSE", reason: "PARTIAL_TAKE_PROFIT_" + i, levelIndex: i, qtyRaw: qty.toString() };
      }
    }
  }
  return { action: "HOLD", reason: "NO_EXIT_TRIGGER" };
}

async function readEntryMetadata(db) {
  if (!db?.prepare) return [];
  const result = await db.prepare("SELECT signal_id,payload_json FROM leverup_execution_intents WHERE action = 0 AND status IN ('EXECUTED','RECONCILED','SUBMITTED','PENDING')").all();
  return (result.results || []).map((row) => {
    try { return { signalId: row.signal_id, ...JSON.parse(row.payload_json || "{}") }; } catch { return { signalId: row.signal_id }; }
  });
}

export async function runLeverUpPositionManager({ env, db, now = Date.now(), dependencies = {} }) {
  const traderAddress = String(env?.LEVERUP_TRADER_ADDRESS || "");
  const agentAddress = String(env?.LEVERUP_AGENT_ADDRESS || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(traderAddress) || !/^0x[0-9a-fA-F]{40}$/.test(agentAddress)) {
    return { status: "BLOCKED_WALLET_CONFIGURATION", checked: 0, submitted: 0 };
  }
  const fetchImpl = dependencies.fetchImpl || fetch;
  const client = dependencies.publicClient || createLeverUpPublicClient(env?.LEVERUP_RPC_URL || "https://rpc.monad.xyz");
  const apiPositions = await (dependencies.fetchOpenPositions || fetchOpenPositions)(traderAddress, { fetchImpl });
  if (!apiPositions.length) return { status: liveEnabled(env) ? "LIVE_MONITORING" : "READ_ONLY_MONITORING", checked: 0, submitted: 0 };
  const pairBases = [...new Set(apiPositions.map((p) => String(p.pairBase || p.pair?.base || "").toLowerCase()).filter((x) => /^0x[0-9a-f]{40}$/.test(x)))];
  if (!pairBases.length) throw new Error("OPEN_POSITION_PAIR_BASE_MISSING");
  const [prices, antiDdos, auth, entries] = await Promise.all([
    (dependencies.fetchPrices || fetchLatestOraclePrices)(pairBases, { fetchImpl }),
    (dependencies.fetchAntiDdos || fetchAntiDdosConfig)({ fetchImpl }),
    (dependencies.readAuthorization || readAgentAuthorization)(traderAddress, agentAddress, { publicClient: client }),
    readEntryMetadata(db),
  ]);
  const [positionsByPair, pairViews] = await Promise.all([
    Promise.all(pairBases.map(async (base) => [base, await (dependencies.readPositions || readPositionsV4)(traderAddress, base, { publicClient: client })])),
    Promise.all(pairBases.map(async (base) => [base, await (dependencies.readPair || readPairByBaseV4)(base, { publicClient: client })])),
  ]);
  const positionMap = new Map();
  for (const [base, rows] of positionsByPair) for (const row of rows || []) {
    const position = normalizePositionAccrual(row);
    positionMap.set(position.positionHash.toLowerCase(), { ...position, pairBase: base });
  }
  const pairMap = new Map(pairViews);
  const feeTokens = (antiDdos.config || []).filter((x) => x.enabled && x.feeToken).map((x) => x.feeToken);
  const balances = await (dependencies.readBalances || readTokenBalancesAndAllowances)(traderAddress, feeTokens, { publicClient: client });
  let submitted = 0, snapshots = 0, evaluated = 0;
  for (const [hash, position] of positionMap) {
    evaluated++;
    const pairView = pairMap.get(position.pairBase);
    if (!pairView) continue;
    const latestPrice = prices[position.pairBase];
    if (!latestPrice) continue;
    const saved = entries.find((x) => String(x.positionHash || "").toLowerCase() === hash);
    const candidate = saved?.candidate || {};
    const partials = Array.isArray(candidate.partialTakeProfits) ? candidate.partialTakeProfits : [];
    const completed = Array.isArray(saved?.completedPartialLevels) ? saved.completedPartialLevels : [];
    const action = evaluateLeverUpPositionAction({
      position, currentPriceRaw: latestPrice, now,
      maxHoldMinutes: Number(candidate.holdMinutes || 180), partialTakeProfits: partials, completedPartialLevels: completed,
    });
    if (db?.prepare) {
      const stored = await (dependencies.persistFeeSnapshot || persistPositionFeeSnapshot)(db, position, null, 300_000);
      if (stored?.stored) snapshots++;
    }
    if (!liveEnabled(env) || action.action === "HOLD" || action.action === "WAIT") continue;
    if (action.action === "MARKET_CLOSE" && !auth.canMarketClose) continue;
    if (action.action === "PARTIAL_CLOSE" && !auth.canPartialClose) continue;
    const oneClickAction = action.action === "PARTIAL_CLOSE" ? OneClickAction.PARTIAL_CLOSE : OneClickAction.MARKET_CLOSE;
    const slippage = BigInt(position.isLong ? pairView.slippageConfig.slippageLongP : pairView.slippageConfig.slippageShortP);
    const actionValues = action.action === "PARTIAL_CLOSE"
      ? [position.positionHash, BigInt(action.qtyRaw), slippage]
      : [position.positionHash, slippage];
    const fee = selectFeeToken(oneClickAction, antiDdos.config, balances, [], { requireAllowance: false });
    const nonce = await (dependencies.readNonce || readLastAgentNonce)(traderAddress, agentAddress, { publicClient: client });
    const signalId = "position-" + hash.slice(2, 22) + "-" + action.action.toLowerCase() + (action.levelIndex == null ? "" : "-" + action.levelIndex);
    const result = await submitLeverUpIntent({
      env, db, signalId, action: oneClickAction, actionValues, traderAddress, agentAddress,
      agentAuthorization: auth, nonce: (BigInt(nonce) + 1n).toString(), deadline: Math.floor(now / 1000) + 300,
      feeToken: fee.feeToken, antiDdosFee: fee.antiDdosFee,
      allowanceRequirements: fee.feeToken.toLowerCase() === ZERO.toLowerCase() ? [] : [{ tokenAddress: fee.feeToken, amount: fee.antiDdosFee }],
      pairBase: position.pairBase, payload: { positionHash: position.positionHash, action: action.action, reason: action.reason, levelIndex: action.levelIndex ?? null },
      now, dependencies,
    });
    if (result.submitted) submitted++;
  }
  return { status: liveEnabled(env) ? "LIVE_MONITORING" : "READ_ONLY_MONITORING", checked: evaluated, submitted, snapshots, openPositionCount: positionMap.size };
}
