import { createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
// Durable, idempotent LeverUp 1CT execution and position lifecycle.
import { evaluateLeverUpPortfolioRisk } from "./leverup-risk.js";
import {
  LEVERUP_1CT, OneClickAction, getIntentStatusOnce, selectFeeToken, signAndSubmitIntent,
} from "./leverup-1ct.js";
import { ensureLeverUpTokenAllowance } from "./leverup-approval.js";
import { evaluateAdaptiveLeverUpExit } from "./leverup-adaptive-exits.js";
import { reviewLeverUpPositionWithGemini } from "./leverup-position-ai.js";
import {
  LEVERUP_TOKENS, createLeverUpPublicClient, fetchOpenPositions, fetchAllPositions, fetchLeverUpPairs,
  fetchLatestOraclePrices, fetchAntiDdosConfig, readPositionsV4, normalizePositionAccrual,
  readPairByBaseV4, readTokenBalancesAndAllowances, readAgentAuthorization, readLastAgentNonce,
  persistPositionFeeSnapshot, reconcileClosedPosition, persistSettlementReconciliation,
} from "./leverup-readonly.js";

const MONAD_ONCHAIN = defineChain({
  id: 143, name: "Monad",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc2.monad.xyz"] } },
});
const OPEN_MARKET_ABI = [{
  type: "function", name: "openMarketTradeV2", stateMutability: "payable",
  inputs: [
    { name: "data", type: "tuple", components: [
      { name: "pairBase", type: "address" }, { name: "isLong", type: "bool" },
      { name: "tokenIn", type: "address" }, { name: "lvToken", type: "address" },
      { name: "amountIn", type: "uint96" }, { name: "qty", type: "uint128" },
      { name: "price", type: "uint128" }, { name: "stopLoss", type: "uint128" },
      { name: "takeProfit", type: "uint128" }, { name: "broker", type: "uint24" },
    ]},
    { name: "updateData", type: "tuple", components: [
      { name: "pythPriceUpdateData", type: "bytes[]" },
      { name: "pythProPriceUpdateData", type: "bytes[]" },
    ]},
    { name: "extraFee", type: "uint96" },
  ],
  outputs: [{ name: "tradeHash", type: "bytes32" }],
}];

const WMON = LEVERUP_TOKENS.WMON.toLowerCase();
const LVMON = LEVERUP_TOKENS.LVMON.toLowerCase();
const ZERO = LEVERUP_1CT.zeroAddress;
const serializable = (value) => JSON.parse(JSON.stringify(value, (_k, v) => typeof v === "bigint" ? v.toString() : v));
const liveEnabled = (env) => String(env?.LEVERUP_LIVE_TRADING).toLowerCase() === "true" &&
  String(env?.LEVERUP_KILL_SWITCH).toLowerCase() === "false";

export function leverUpTradeInstanceId(entry) {
  const id = String(entry?.tradeId || entry?.signalId || "").trim();
  return id || null;
}

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
    maxConcurrentPositions: Math.max(2, Number(env?.LEVERUP_MAX_CONCURRENT_POSITIONS ?? 2)),
    proposedStopRiskMon: preflight.stopRiskMon,
    aggregateStopRiskMon: portfolio?.aggregateStopRiskMon ?? 0,
    maxAggregateStopRiskMon: Math.max(20, Number(env?.LEVERUP_MAX_AGGREGATE_STOP_RISK_MON ?? 60)),
    dailyRealizedLossMon: portfolio?.dailyRealizedLossMon ?? 0,
    maxDailyRealizedLossMon: Math.max(20, Number(env?.LEVERUP_MAX_DAILY_LOSS_MON ?? 60)),
    rollingDrawdownMon: portfolio?.rollingDrawdownMon ?? 0,
    maxRollingDrawdownMon: Math.max(20, Number(env?.LEVERUP_MAX_DRAWDOWN_MON ?? 60)),
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

async function findExistingIntent(db, signalId, idempotencyKey) {
  const bySignal = await db.prepare("SELECT * FROM leverup_execution_intents WHERE signal_id = ?").bind(signalId).first();
  if (bySignal) return bySignal;
  return db.prepare("SELECT * FROM leverup_execution_intents WHERE idempotency_key = ?").bind(idempotencyKey).first();
}

async function claimIntent(db, { signalId, action, pairBase, leverage, marginMon, notionalUsd, payload, now, executionPath = "1ct", maxConcurrentPositions = 2 }) {
  if (!db?.prepare) throw new Error("LEVERUP_D1_LEDGER_UNAVAILABLE");
  const idempotencyKey = "ciel:leverup:" + executionPath + ":" + signalId;
  const existing = await findExistingIntent(db, signalId, idempotencyKey);
  if (existing) return { created: false, row: existing };

  try {
    await db.prepare(`INSERT INTO leverup_execution_intents
      (signal_id,idempotency_key,status,pair_base,action,requested_leverage,margin_mon,notional_usd,payload_json,created_at_ms,updated_at_ms)
      VALUES (?,?, 'PREPARED', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(signalId,idempotencyKey,pairBase || null,action,leverage || null,marginMon || null,notionalUsd || null,
        JSON.stringify(serializable(payload)),now,now).run();
  } catch (error) {
    const duplicate = await findExistingIntent(db, signalId, idempotencyKey).catch(() => null);
    if (duplicate) return { created: false, row: duplicate };
    if (Number(action) === OneClickAction.MARKET_OPEN) {
      const activeCount = await db.prepare(`SELECT COUNT(*) AS count FROM leverup_execution_intents
        WHERE action = ? AND status IN ('PREPARED','UNCERTAIN','SUBMITTED','PENDING','EXECUTED','RECONCILED')
          AND (status != 'RECONCILED' OR json_extract(payload_json,'$.closedAt') IS NULL)`)
        .bind(OneClickAction.MARKET_OPEN).first().catch(() => null);
      if (Number(activeCount?.count || 0) >= Number(maxConcurrentPositions)) {
        return { created: false, row: { signal_id: null, status: "MAX_CONCURRENT_POSITIONS_REACHED" }, blockedByActiveEntry: true };
      }
    }
    throw new Error("LEVERUP_IDEMPOTENCY_CLAIM_FAILED: " + String(error?.message || error).slice(0, 220));
  }

  const claimed = await db.prepare("SELECT * FROM leverup_execution_intents WHERE signal_id = ?").bind(signalId).first();
  if (!claimed) throw new Error("LEVERUP_IDEMPOTENCY_CLAIM_NOT_CONFIRMED");
  return { created: true, row: claimed };
}

function decodeLeverUpIntentFailureReason(value) {
  const raw = String(value || "");
  if (!raw.startsWith("0x08c379a0")) return raw.slice(0, 300);
  try {
    const body = raw.slice(10);
    const offset = Number(BigInt("0x" + body.slice(0, 64)));
    const lengthStart = offset * 2;
    const length = Number(BigInt("0x" + body.slice(lengthStart, lengthStart + 64)));
    const encoded = body.slice(lengthStart + 64, lengthStart + 64 + length * 2);
    const bytes = new Uint8Array(encoded.match(/.{2}/g).map((byte) => parseInt(byte, 16)));
    return new TextDecoder().decode(bytes).slice(0, 300);
  } catch {
    return raw.slice(0, 300);
  }
}

/**
 * Exactly-once safety is achieved by claiming the unique D1 signal key before POST.
 * If a request becomes ambiguous after the claim, it is marked UNCERTAIN and is never
 * resubmitted automatically. This prefers a manual reconciliation over a duplicate order.
 */
export function refreshLeverUpMarketOpenPlan({
  plan, pairView, freshOraclePriceRaw, now = Date.now(),
  entryPriceToleranceBps = 30, leverageHeadroomBps = 50,
}) {
  if (!plan?.preflight || !Array.isArray(plan.actionValues) || plan.actionValues.length < 11 || !pairView?.slippageConfig) {
    throw new Error("MARKET_OPEN_PLAN_REFRESH_INPUT_INVALID");
  }
  const price = BigInt(freshOraclePriceRaw);
  if (price <= 0n) throw new Error("FRESH_ORACLE_PRICE_INVALID");
  const values = [...plan.actionValues];
  const isLong = Boolean(values[1]);
  const notionalRaw = BigInt(plan.preflight.notionalUsdRaw);
  if (notionalRaw <= 0n) throw new Error("PREFLIGHT_NOTIONAL_INVALID");
  const slippage = pairView.slippageConfig;
  if (!slippage.enabled) throw new Error("LIVE_SLIPPAGE_CONFIG_DISABLED_OR_MISSING");
  if (Number(slippage.slippageType) !== 0) throw new Error("LIVE_SLIPPAGE_TYPE_UNSUPPORTED");
  const protocolSlippageP = BigInt(isLong ? slippage.slippageLongP : slippage.slippageShortP);
  if (protocolSlippageP < 0n || protocolSlippageP > 10_000n) throw new Error("LIVE_SLIPPAGE_BOUND_INVALID");
  const requestedToleranceBps = Number(entryPriceToleranceBps);
  if (!Number.isInteger(requestedToleranceBps) || requestedToleranceBps < 0 || requestedToleranceBps > 100) throw new Error("LIVE_ENTRY_PRICE_TOLERANCE_INVALID");
  const headroomBps = Number(leverageHeadroomBps);
  if (!Number.isInteger(headroomBps) || headroomBps < 0 || headroomBps > 1_000) throw new Error("LIVE_LEVERAGE_HEADROOM_INVALID");
  const toleranceP = BigInt(requestedToleranceBps);
  const slippageP = protocolSlippageP > toleranceP ? protocolSlippageP : toleranceP;
  const denominator = 10_000n;
  const upperPriceRaw = (price * (denominator + slippageP) + denominator - 1n) / denominator;
  // Keep the actual contract slippage bound directional: longs use the upper
  // bound and shorts retain the lower bound. Quantity sizing is different:
  // both directions are sized against the upper price so a short cannot exceed
  // its leverage tier when the checker values qty at the live oracle price.
  const worstPriceRaw = isLong
    ? upperPriceRaw
    : price * (denominator - slippageP) / denominator;
  const sizingPriceRaw = upperPriceRaw;
  const bufferedNotionalRaw = notionalRaw * (denominator - BigInt(headroomBps)) / denominator;
  const qtyRaw = bufferedNotionalRaw * (10n ** 10n) / sizingPriceRaw;
  if (qtyRaw <= 0n || qtyRaw > (2n ** 128n - 1n)) throw new Error("FRESH_ORACLE_QTY_OUT_OF_RANGE");
  const stop = BigInt(values[7] || 0);
  const target = BigInt(values[8] || 0);
  if (isLong && ((stop > 0n && stop >= price) || (target > 0n && target <= price))) {
    throw new Error("FRESH_ORACLE_INVALIDATES_LONG_TP_SL");
  }
  if (!isLong && ((stop > 0n && stop <= price) || (target > 0n && target >= price))) {
    throw new Error("FRESH_ORACLE_INVALIDATES_SHORT_TP_SL");
  }
  values[5] = qtyRaw;
  values[6] = worstPriceRaw;
  return {
    ...plan,
    actionValues: values,
    qtyRaw: qtyRaw.toString(),
    worstPriceRaw: worstPriceRaw.toString(),
    sizingPriceRaw: sizingPriceRaw.toString(),
    leverageHeadroomBps: String(headroomBps),
    protocolSlippageBps: protocolSlippageP.toString(),
    slippageBps: slippageP.toString(),
    preflight: {
      ...plan.preflight,
      checkedAt: now,
      oraclePriceRaw: price.toString(),
      oraclePriceUsd: Number(price) / 1e18,
      sizingPriceRaw: sizingPriceRaw.toString(),
      leverageHeadroomBps: String(headroomBps),
    },
  };
}

export function calculateLeverUpQuoteDriftBps(referencePriceRaw, currentPriceRaw) {
  const reference = BigInt(referencePriceRaw);
  const current = BigInt(currentPriceRaw);
  if (reference <= 0n || current <= 0n) throw new Error("LEVERUP_QUOTE_PRICE_INVALID");
  const difference = current >= reference ? current - reference : reference - current;
  return (difference * 10_000n + reference - 1n) / reference;
}

export function validateLeverUpQuoteAge(checkedAt, observedAt, maxAgeMs = 30_000) {
  const checked = Number(checkedAt);
  const observed = Number(observedAt);
  const maximum = Number(maxAgeMs);
  if (!Number.isFinite(checked) || checked <= 0 || !Number.isFinite(observed) || observed <= 0) {
    throw new Error("LEVERUP_QUOTE_TIMESTAMP_INVALID");
  }
  if (!Number.isInteger(maximum) || maximum < 1_000 || maximum > 120_000) {
    throw new Error("LEVERUP_MAX_QUOTE_AGE_CONFIG_INVALID");
  }
  const age = observed - checked;
  if (age < 0) throw new Error("LEVERUP_QUOTE_CLOCK_SKEW");
  if (age > maximum) throw new Error("LEVERUP_QUOTE_STALE: " + age + "ms > " + maximum + "ms");
  return age;
}

export function validateLeverUpTransferBalances({ action, actionValues, feeToken = ZERO, antiDdosFee = 0n, tokenStates = {} }) {
  if (Number(action) !== OneClickAction.MARKET_OPEN) return { ok: true, required: {}, observed: {} };
  if (!Array.isArray(actionValues) || actionValues.length < 11) throw new Error("MARKET_OPEN_TRANSFER_INPUT_INVALID");
  const required = new Map();
  const add = (token, amount) => {
    const key = String(token || "").toLowerCase();
    const value = BigInt(amount || 0);
    if (!key || key === ZERO.toLowerCase() || value <= 0n) return;
    required.set(key, (required.get(key) || 0n) + value);
  };
  add(actionValues[2], BigInt(actionValues[4]) + BigInt(actionValues[10] || 0));
  add(feeToken, antiDdosFee);
  const failures = [];
  const requirements = {};
  for (const [token, amount] of required) {
    const state = tokenStates[token];
    const balance = BigInt(state?.balance ?? 0);
    const allowance = BigInt(state?.allowance ?? 0);
    requirements[token] = { required: amount.toString(), balance: balance.toString(), allowance: allowance.toString() };
    if (balance < amount) failures.push({ token, reason: "BALANCE_INSUFFICIENT", required: amount.toString(), actual: balance.toString() });
    if (allowance < amount) failures.push({ token, reason: "ALLOWANCE_INSUFFICIENT", required: amount.toString(), actual: allowance.toString() });
  }
  const diagnosticTokens = [...new Set([String(actionValues[2] || "").toLowerCase(), String(actionValues[3] || "").toLowerCase()])]
    .filter((token) => token && token !== ZERO.toLowerCase());
  const observed = Object.fromEntries(diagnosticTokens.map((token) => {
    const state = tokenStates[token];
    return [token, state ? { balance: String(state.balance), allowance: String(state.allowance) } : { unavailable: true }];
  }));
  return { ok: failures.length === 0, required: requirements, observed, failures };
}

export async function submitLeverUpIntent({
  env, db, signalId, action, actionValues, traderAddress, agentAddress, agentAuthorization,
  nonce, deadline, feeToken = ZERO, antiDdosFee = 0n, preflight = null,
  allowanceRequirements = [], pairBase = null, leverage = null, marginMon = null,
  notionalUsd = null, payload = {}, now = Date.now(), dependencies = {}, allowRiskReducingClose = false,
}) {
  const closeOnly = Number(action) === OneClickAction.MARKET_CLOSE || Number(action) === OneClickAction.PARTIAL_CLOSE;
  const emergencyCloseEnabled = allowRiskReducingClose && closeOnly && (
    String(env?.LEVERUP_LIVE_TRADING).toLowerCase() === "true" ||
    String(env?.LEVERUP_PURGE_LIVE_ENABLED).toLowerCase() === "true"
  );
  if (!liveEnabled(env) && !emergencyCloseEnabled) return { status: "LIVE_DISABLED", submitted: false };
  if (!signalId || !Number.isInteger(Number(action))) throw new Error("LEVERUP_INTENT_INPUT_INVALID");
  const claim = await claimIntent(db, { signalId, action, pairBase, leverage, marginMon, notionalUsd,
    payload: { ...payload, action, actionValues: serializable(actionValues), feeToken, antiDdosFee: String(antiDdosFee) }, now,
    maxConcurrentPositions: 2 });
  if (!claim.created) {
    if (claim.blockedByActiveEntry) {
      return { status: "ENTRY_SLOT_RESERVED", submitted: false, blockedByActiveEntry: true, reservedSignalId: claim.row?.signal_id || null };
    }
    return { status: claim.row?.status || "DUPLICATE", duplicate: true, intentHash: claim.row?.intent_hash || null };
  }

  let markedUncertain = false;
  let transferPreflight = null;
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
    if (Number(action) === OneClickAction.MARKET_OPEN) {
      const diagnosticTokens = [...new Set([
        actionValues?.[2], actionValues?.[3], feeToken,
      ].filter((token) => token && String(token).toLowerCase() !== ZERO.toLowerCase()))];
      const readStates = dependencies.readTokenBalancesAndAllowances || readTokenBalancesAndAllowances;
      const tokenStates = await readStates(traderAddress, diagnosticTokens, {
        publicClient: dependencies.publicClient || createLeverUpPublicClient(env?.ALCHEMY_RPC || env?.LEVERUP_RPC_URL || "https://rpc2.monad.xyz"),
      });
      const transferCheck = validateLeverUpTransferBalances({
        action, actionValues, feeToken, antiDdosFee, tokenStates,
      });
      transferPreflight = serializable(transferCheck);
      await updateIntent(db, signalId, "PREPARED", {
        payload: { ...payload, action, actionValues: serializable(actionValues), transferPreflight },
      });
      if (!transferCheck.ok) {
        throw new Error("LEVERUP_TRANSFER_PREFLIGHT_FAILED: " + JSON.stringify(transferCheck.failures));
      }
    }
    if (typeof dependencies.beforeSubmit === "function") {
      const finalQuote = await dependencies.beforeSubmit({ actionValues, preflight, payload, now });
      if (!finalQuote || !Array.isArray(finalQuote.actionValues) || finalQuote.actionValues.length < 11) {
        throw new Error("LEVERUP_FINAL_QUOTE_REFRESH_INVALID");
      }
      actionValues = finalQuote.actionValues;
      preflight = finalQuote.preflight || preflight;
      payload = finalQuote.payload || payload;
    }
    await updateIntent(db, signalId, "UNCERTAIN", { payload: { ...payload, action, actionValues: serializable(actionValues), preflight: serializable(preflight), transferPreflight, submissionStartedAt: Date.now() } });
    markedUncertain = true;
    const submit = dependencies.submit || signAndSubmitIntent;
    const result = await submit({
      enabled: true, killSwitchActive: false, traderAddress, agentAddress, agentAuthorization,
      signerPrivateKey: env.LEVERUP_AGENT_PRIVATE_KEY, action, nonce, deadline, actionValues,
      feeToken, antiDdosFee, preflight, fetchImpl: dependencies.fetchImpl,
    });
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(result.intentHash || ""))) {
      return { status: "UNCERTAIN", submitted: true, signalId, reason: "SUBMISSION_RESPONSE_MISSING_VALID_INTENT_HASH" };
    }
    try {
      await updateIntent(db, signalId, "SUBMITTED", { intentHash: result.intentHash,
        payload: { ...payload, action, actionValues: serializable(actionValues), transferPreflight, intentDigest: result.intent?.actionDataHash || null } });
    } catch (ledgerError) {
      // The order may already be live. Keep the pre-submit UNCERTAIN claim and never replay it.
      return { status: "UNCERTAIN", submitted: true, intentHash: result.intentHash, signalId,
        reason: "SUBMISSION_ACCEPTED_BUT_D1_STATUS_WRITE_FAILED: " + String(ledgerError?.message || ledgerError).slice(0, 180) };
    }
    return { status: "SUBMITTED", submitted: true, intentHash: result.intentHash, signalId };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 300);
    await updateIntent(db, signalId, markedUncertain ? "UNCERTAIN" : "REJECTED", { lastError: message }).catch(() => void 0);
    return { status: markedUncertain ? "UNCERTAIN" : "REJECTED", submitted: markedUncertain, signalId, reason: message };
  }
}


/**
 * Exercises the production D1 idempotency claim and status reconciliation path
 * using a temporary risk-reducing intent. No allowance helper, signer, or submit
 * function is called. The temporary row is deleted in a finally block.
 */
export async function verifyLeverUpCoordinatorDryRun({ env, db, now = Date.now(), dependencies = {} }) {
  if (String(env?.LEVERUP_LIVE_TRADING).toLowerCase() !== "false" ||
      String(env?.LEVERUP_KILL_SWITCH).toLowerCase() !== "true") {
    return { status: "BLOCKED_SAFETY_CONFIGURATION", orderSubmitted: false };
  }
  if (!db?.prepare) return { status: "BLOCKED_D1_LEDGER_UNAVAILABLE", orderSubmitted: false };
  const signalId = "ciel-diagnostic-" + now + "-" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  let claimed = false;
  try {
    const input = {
      signalId, action: OneClickAction.MARKET_CLOSE, pairBase: null,
      leverage: null, marginMon: null, notionalUsd: null,
      payload: { diagnostic: true, orderSubmitted: false }, now,
    };
    const first = await claimIntent(db, input);
    if (!first.created) throw new Error("DIAGNOSTIC_INTENT_CLAIM_FAILED");
    claimed = true;
    const duplicate = await claimIntent(db, input);
    if (duplicate.created || duplicate.row?.status !== "PREPARED") {
      throw new Error("DIAGNOSTIC_IDEMPOTENCY_CHECK_FAILED");
    }
    const fakeHash = "0x" + "ab".repeat(32);
    await updateIntent(db, signalId, "SUBMITTED", {
      intentHash: fakeHash,
      payload: { diagnostic: true, orderSubmitted: false },
    });
    const reconciliation = await reconcilePendingLeverUpIntents({
      env, db, now,
      dependencies: {
        getStatus: async () => ({ executed: true, skipped: false, diagnostic: true }),
        fetchOpenPositions: async () => [],
        ...dependencies,
      },
    });
    const row = await db.prepare(
      "SELECT status,intent_hash,payload_json FROM leverup_execution_intents WHERE signal_id = ?",
    ).bind(signalId).first();
    if (row?.status !== "EXECUTED" || row?.intent_hash !== fakeHash ||
        JSON.parse(row?.payload_json || "{}").orderSubmitted !== false ||
        reconciliation.reconciled !== 1) {
      throw new Error("DIAGNOSTIC_STATUS_RECONCILIATION_FAILED");
    }
    return {
      status: "PASS", orderSubmitted: false, intentClaimed: true,
      duplicateBlocked: true, statusReconciled: true, temporaryRowCleaned: true,
      reconciliation,
    };
  } catch (error) {
    return { status: "FAILED", orderSubmitted: false, reason: String(error?.message || error).slice(0, 220) };
  } finally {
    if (claimed) {
      await db.prepare("DELETE FROM leverup_execution_intents WHERE signal_id = ?")
        .bind(signalId).run().catch(() => void 0);
    }
  }
}

async function readPortfolioRiskFromLedger(db, now) {
  if (!db?.prepare) throw new Error("LEVERUP_RISK_LEDGER_UNAVAILABLE");
  const dayStartSeconds = Math.floor(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) / 1000);
  const [daily, history] = await Promise.all([
    db.prepare("SELECT l.net_pnl_after_fees_raw, l.close_time FROM leverup_settlement_reconciliations l WHERE l.close_time >= ? AND NOT EXISTS (SELECT 1 FROM leverup_trade_settlements t WHERE t.position_hash = l.position_hash AND t.close_time = l.close_time) UNION ALL SELECT net_pnl_after_fees_raw, close_time FROM leverup_trade_settlements WHERE close_time >= ? ORDER BY close_time ASC")
      .bind(dayStartSeconds, dayStartSeconds).all(),
    db.prepare("SELECT net_pnl_after_fees_raw, close_time FROM (SELECT l.net_pnl_after_fees_raw, l.close_time FROM leverup_settlement_reconciliations l WHERE NOT EXISTS (SELECT 1 FROM leverup_trade_settlements t WHERE t.position_hash = l.position_hash AND t.close_time = l.close_time) UNION ALL SELECT net_pnl_after_fees_raw, close_time FROM leverup_trade_settlements) ORDER BY close_time DESC LIMIT 300").all(),
  ]);
  const [activeEntries] = await Promise.all([
    db.prepare("SELECT payload_json FROM leverup_execution_intents WHERE action = 0 AND status IN ('EXECUTED','RECONCILED','SUBMITTED','PENDING','UNCERTAIN') AND (status != 'RECONCILED' OR json_extract(payload_json,'$.closedAt') IS NULL)").all(),
  ]);
  const toMon = (raw) => Number(BigInt(raw || "0")) / 1e18;
  const dailyRealizedLossMon = (daily.results || []).reduce((sum, row) => sum + Math.max(0, -toMon(row.net_pnl_after_fees_raw)), 0);
  let equity = 0, peak = 0, rollingDrawdownMon = 0;
  for (const row of [...(history.results || [])].reverse()) {
    equity += toMon(row.net_pnl_after_fees_raw);
    peak = Math.max(peak, equity);
    rollingDrawdownMon = Math.max(rollingDrawdownMon, peak - equity);
  }
  // Reserve stop-risk for every open or not-yet-reconciled entry. If the intent
  // is still pending/uncertain, keep its risk reserved rather than treating it as zero.
  const aggregateStopRiskMon = (activeEntries.results || []).reduce((sum, row) => {
    try {
      const payload = JSON.parse(row.payload_json || "{}");
      const risk = Number(payload.stopRiskMon ?? payload.plan?.stopRiskMon ?? 0);
      return sum + (Number.isFinite(risk) && risk > 0 ? risk : 0);
    } catch { return sum; }
  }, 0);
  return { dailyRealizedLossMon, rollingDrawdownMon, aggregateStopRiskMon, source: "leverup_settlement_reconciliations+active_execution_intents" };
}

async function fetchLeverUpOnchainOracleUpdate(pairBase, fetchImpl = fetch) {
  const response = await fetchImpl("https://service.leverup.xyz/v1/oracle/price/updates/by-position", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pairBase, collateral: LEVERUP_TOKENS.WMON, blockChain: "MONAD",
      options: { includeEncodingData: true, includeFee: true, includePrice: true, includePublishTime: false, includeEncodingDataByOracleId: false, includePriceSafety: false, allowPartial: false },
    }),
  });
  if (!response.ok) throw new Error("LEVERUP_ORACLE_UPDATE_HTTP_" + response.status);
  const data = await response.json();
  if (Array.isArray(data.failures) && data.failures.length) throw new Error("LEVERUP_ORACLE_UPDATE_FAILED: " + JSON.stringify(data.failures).slice(0, 180));
  return {
    updateData: { pythPriceUpdateData: data.pythPriceUpdateData || [], pythProPriceUpdateData: data.pythProPriceUpdateData || [] },
    value: BigInt(data.updateFee || "0") + BigInt(data.verifition_fee || "0"),
  };
}

export async function submitLeverUpNativeOnchainEntry({
  env, db, signalId, candidate, plan, traderAddress, pairBase, oracleUpdate,
  now = Date.now(), dependencies = {},
}) {
  if (!liveEnabled(env)) return { status: "LIVE_DISABLED", submitted: false };
  const claim = await claimIntent(db, {
    signalId, action: OneClickAction.MARKET_OPEN, pairBase,
    leverage: plan.selectedLeverage, marginMon: plan.marginMonUsed, notionalUsd: plan.notionalUsd,
    payload: { executionPath: "ONCHAIN_NATIVE", candidate, plan: serializable(plan), submittedAt: now },
    now, executionPath: "onchain-native",
  });
  if (!claim.created) return { status: claim.row?.status || "DUPLICATE", duplicate: true, transactionHash: claim.row?.intent_hash || null };
  let broadcastStarted = false;
  try {
    const rpcUrl = env?.ALCHEMY_RPC || env?.LEVERUP_RPC_URL || "https://rpc2.monad.xyz";
    const rawKey = String(env?.LEVERUP_TRADER_PRIVATE_KEY || "").trim();
    const key = rawKey.startsWith("0x") ? rawKey : "0x" + rawKey;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("LEVERUP_TRADER_PRIVATE_KEY_MISSING_OR_INVALID");
    const account = privateKeyToAccount(key);
    if (account.address.toLowerCase() !== String(traderAddress).toLowerCase()) throw new Error("LEVERUP_TRADER_SIGNER_ADDRESS_MISMATCH");
    const client = dependencies.publicClient || createLeverUpPublicClient(rpcUrl);
    const wallet = dependencies.walletClient || createWalletClient({ account, chain: MONAD_ONCHAIN, transport: http(rpcUrl) });
    const v = plan.actionValues;
    if (String(v[2]).toLowerCase() !== ZERO.toLowerCase() || String(v[3]).toLowerCase() !== LEVERUP_TOKENS.LVMON.toLowerCase()) {
      throw new Error("NATIVE_MON_LVMON_COLLATERAL_PAIR_MISMATCH");
    }
    const amountIn = BigInt(v[4]);
    const extraFee = BigInt(v[10] || 0);
    const value = amountIn + extraFee + BigInt(oracleUpdate.value);
    const balance = BigInt(await (dependencies.getBalance || client.getBalance.bind(client))({ address: traderAddress }));
    if (balance < value + 20_000_000_000_000_000n) throw new Error("NATIVE_MON_BALANCE_INSUFFICIENT_FOR_COLLATERAL_OR_GAS");
    const args = [{
      pairBase: String(v[0]), isLong: Boolean(v[1]), tokenIn: ZERO, lvToken: LEVERUP_TOKENS.LVMON,
      amountIn, qty: BigInt(v[5]), price: BigInt(v[6]), stopLoss: BigInt(v[7] || 0),
      takeProfit: BigInt(v[8] || 0), broker: Number(v[9] || 0),
    }, oracleUpdate.updateData, extraFee];
    const request = await client.simulateContract({
      account, address: LEVERUP_1CT.diamond, abi: OPEN_MARKET_ABI,
      functionName: "openMarketTradeV2", args, value,
    });
    await updateIntent(db, signalId, "UNCERTAIN", {
      payload: { executionPath: "ONCHAIN_NATIVE", candidate, plan: serializable(plan), oracleValue: oracleUpdate.value.toString(), submissionStartedAt: now },
    });
    broadcastStarted = true;
    const hash = await wallet.writeContract(request.request);
    await updateIntent(db, signalId, "SUBMITTED", {
      intentHash: hash,
      payload: { executionPath: "ONCHAIN_NATIVE", candidate, plan: serializable(plan), transactionHash: hash, oracleValue: oracleUpdate.value.toString(), submittedAt: now },
    });
    let receipt;
    try { receipt = await client.waitForTransactionReceipt({ hash, timeout: 30_000 }); }
    catch (error) {
      await updateIntent(db, signalId, "PENDING", { lastError: "RECEIPT_PENDING: " + String(error?.message || error).slice(0, 120) });
      return { status: "PENDING", submitted: true, transactionHash: hash, signalId };
    }
    if (receipt.status !== "success") {
      await updateIntent(db, signalId, "REJECTED", { lastError: "ONCHAIN_MARKET_OPEN_TRANSACTION_REVERTED", payload: { executionPath: "ONCHAIN_NATIVE", candidate, plan: serializable(plan), transactionHash: hash, receiptBlock: String(receipt.blockNumber) } });
      return { status: "REJECTED", submitted: true, transactionHash: hash, signalId, reason: "ONCHAIN_MARKET_OPEN_TRANSACTION_REVERTED" };
    }
    const positions = await (dependencies.readPositions || readPositionsV4)(traderAddress, pairBase, { publicClient: client });
    const matches = (positions || []).filter((p) => Boolean(p.isLong) === (candidate.side === "LONG"));
    if (matches.length === 1) {
      const position = normalizePositionAccrual(matches[0]);
      await updateIntent(db, signalId, "EXECUTED", {
        payload: { executionPath: "ONCHAIN_NATIVE", candidate, plan: serializable(plan), transactionHash: hash, tradeId: signalId, positionHash: position.positionHash, receiptBlock: String(receipt.blockNumber), executedAt: now },
      });
      return { status: "EXECUTED", submitted: true, transactionHash: hash, positionHash: position.positionHash, signalId };
    }
    await updateIntent(db, signalId, "SUBMITTED", {
      payload: { executionPath: "ONCHAIN_NATIVE", candidate, plan: serializable(plan), transactionHash: hash, receiptBlock: String(receipt.blockNumber), keeperPending: true },
    });
    return { status: "SUBMITTED", submitted: true, transactionHash: hash, signalId, positionConfirmed: false, reason: "REQUEST_ACCEPTED_AWAITING_KEEPER_FILL" };
  } catch (error) {
    const message = String(error?.shortMessage || error?.message || error).slice(0, 260);
    await updateIntent(db, signalId, broadcastStarted ? "UNCERTAIN" : "REJECTED", { lastError: message }).catch(() => void 0);
    return { status: broadcastStarted ? "UNCERTAIN" : "REJECTED", submitted: broadcastStarted, signalId, reason: message };
  }
}

export async function executeLeverUpEntry({ env, db, candidate, signalId, snapshot, plan, now = Date.now(), dependencies = {} }) {
  const [liveOverride, entryOverride] = env?.CIEL_STATE && typeof env.CIEL_STATE.get === "function"
    ? await Promise.all([env.CIEL_STATE.get("ciel:control:live-enabled"), env.CIEL_STATE.get("ciel:control:live-entry-enabled")])
    : [null, null];
  const effectiveEnv = liveOverride == null ? env : { ...env, LEVERUP_LIVE_TRADING: liveOverride };
  if (!liveEnabled(effectiveEnv) || liveOverride !== "true" || entryOverride !== "true") return { status: "LIVE_DISABLED", submitted: false };

  const traderAddress = String(snapshot?.traderAddress || effectiveEnv?.LEVERUP_TRADER_ADDRESS || "");
  const agentAddress = String(snapshot?.agentAddress || effectiveEnv?.LEVERUP_AGENT_ADDRESS || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(traderAddress) || !/^0x[0-9a-fA-F]{40}$/.test(agentAddress)) {
    return { status: "REJECTED", submitted: false, reason: "HOSTED_AGENT_WALLET_CONFIGURATION_INVALID" };
  }
  if (!snapshot?.agentAuthorization?.authorized ||
      String(snapshot.agentAuthorization.agentAddress || "").toLowerCase() !== agentAddress.toLowerCase() ||
      snapshot.agentAuthorization.canMarketOpen !== true) {
    return { status: "REJECTED", submitted: false, reason: "HOSTED_AGENT_MARKET_OPEN_PERMISSION_NOT_VERIFIED" };
  }

  let executionPlan = plan;
  try {
    const fetchPrices = dependencies.fetchLatestOraclePrices || fetchLatestOraclePrices;
    const freshPrices = await fetchPrices([snapshot.market.base], { fetchImpl: dependencies.fetchImpl || fetch });
    const freshPrice = freshPrices?.[String(snapshot.market.base).toLowerCase()];
    if (freshPrice == null) throw new Error("FRESH_ORACLE_PRICE_MISSING");
    executionPlan = refreshLeverUpMarketOpenPlan({
      plan, pairView: snapshot.pairView, freshOraclePriceRaw: freshPrice, now,
      entryPriceToleranceBps: Number(effectiveEnv?.LEVERUP_ENTRY_PRICE_TOLERANCE_BPS ?? 30),
      leverageHeadroomBps: Number(effectiveEnv?.LEVERUP_LEVERAGE_HEADROOM_BPS ?? 50),
    });
  } catch (error) {
    return { status: "REJECTED", submitted: false, reason: "FRESH_ORACLE_REFRESH_FAILED: " + String(error?.message || error).slice(0, 180) };
  }

  // Hosted 1CT accepts WMON -> LVMON and direct LVMON collateral.
  // The lvToken field differs by route and is validated before signing.
  const actionValues = executionPlan.actionValues || [];
  const collateralToken = String(actionValues[2] || "").toLowerCase();
  const pairedToken = String(actionValues[3] || "").toLowerCase();
  const validHostedPair =
    (collateralToken === WMON && pairedToken === LVMON) ||
    (collateralToken === LVMON && pairedToken === LVMON);
  if (!validHostedPair) {
    return { status: "REJECTED", submitted: false, reason: "HOSTED_AGENT_COLLATERAL_TOKEN_PAIR_UNSUPPORTED" };
  }
  if (!executionPlan.preflight?.preflightPassed || executionPlan.preflight.status !== "AVAILABLE") {
    return { status: "REJECTED", submitted: false, reason: "HOSTED_AGENT_PREFLIGHT_NOT_PASSED" };
  }

  const collateralState = snapshot.accountTokenStates?.[collateralToken];
  if (!collateralState || collateralState.balance == null) {
    return { status: "REJECTED", submitted: false, reason: "COLLATERAL_BALANCE_NOT_AVAILABLE_FOR_RISK_CHECK" };
  }
  const collateralBalanceMon = Number(BigInt(collateralState.balance)) / 1e18;
  const margin = Number(executionPlan.marginMonUsed);
  const feeToken = String(executionPlan.feeToken || ZERO).toLowerCase();
  const antiDdosFee = BigInt(executionPlan.antiDdosFee || 0);
  const amountIn = BigInt(actionValues[4] || 0);
  const extraFee = BigInt(actionValues[10] || 0);
  const collateralEntrySpend = amountIn + extraFee + (feeToken === collateralToken ? antiDdosFee : 0n);
  const entryBudgetMon = Number(collateralEntrySpend) / 1e18;
  const stopPct = Number(candidate.stopPct);
  const stopRiskMon = margin * Number(executionPlan.selectedLeverage) * stopPct / 100;
  let portfolioRisk;
  try {
    portfolioRisk = dependencies.readPortfolioRisk
      ? await dependencies.readPortfolioRisk(db, now)
      : await readPortfolioRiskFromLedger(db, now);
  } catch (error) {
    return { status: "REJECTED_RISK", submitted: false, reason: "PORTFOLIO_RISK_READ_FAILED: " + String(error?.message || error).slice(0, 160) };
  }
  const risk = evaluateLeverUpPortfolioRisk({
    requestedLeverage: executionPlan.selectedLeverage,
    totalAllocationMon: executionPlan.totalAllocationMon ?? effectiveEnv.LEVERUP_TOTAL_ALLOCATION_MON ?? 50,
    reserveMon: executionPlan.reserveMon ?? effectiveEnv.LEVERUP_RESERVE_MON ?? 25,
    availableWmonMon: collateralBalanceMon, requestedMarginMon: margin, entryBudgetMon,
    currentOpenPositions: snapshot.indexedPositions || [],
    maxConcurrentPositions: Math.max(2, Number(effectiveEnv.LEVERUP_MAX_CONCURRENT_POSITIONS ?? 2)),
    proposedStopRiskMon: stopRiskMon, aggregateStopRiskMon: portfolioRisk.aggregateStopRiskMon,
    maxAggregateStopRiskMon: Math.max(20, Number(effectiveEnv.LEVERUP_MAX_AGGREGATE_STOP_RISK_MON ?? 60)),
    dailyRealizedLossMon: portfolioRisk.dailyRealizedLossMon,
    maxDailyRealizedLossMon: Math.max(20, Number(effectiveEnv.LEVERUP_MAX_DAILY_LOSS_MON ?? 60)),
    rollingDrawdownMon: portfolioRisk.rollingDrawdownMon,
    maxRollingDrawdownMon: Math.max(20, Number(effectiveEnv.LEVERUP_MAX_DRAWDOWN_MON ?? 60)),
    staleFeed: now - Number(snapshot.checkedAt || now) > 30_000,
    executionUncertain: false, killSwitchActive: false,
  });
  if (!risk.allowed) return { status: "REJECTED_RISK", reasons: risk.reasons, risk };

  let nonce;
  try {
    const client = dependencies.publicClient || createLeverUpPublicClient(effectiveEnv?.ALCHEMY_RPC || effectiveEnv?.LEVERUP_RPC_URL || "https://rpc2.monad.xyz");
    const readNonce = dependencies.readNonce || readLastAgentNonce;
    const lastNonce = BigInt(await readNonce(traderAddress, agentAddress, { publicClient: client }));
    const candidates = [lastNonce + 1n, BigInt(now), BigInt(executionPlan.nonce || 0)];
    nonce = candidates.reduce((max, value) => value > max ? value : max, 0n).toString();
  } catch (error) {
    return { status: "REJECTED", submitted: false, reason: "HOSTED_AGENT_NONCE_READ_FAILED: " + String(error?.message || error).slice(0, 160) };
  }

  const allowanceRequirements = [{ tokenAddress: collateralToken, amount: amountIn + extraFee }];
  if (feeToken !== ZERO.toLowerCase() && antiDdosFee > 0n) {
    allowanceRequirements.push({ tokenAddress: feeToken, amount: antiDdosFee });
  }
  const result = await submitLeverUpIntent({
    env: effectiveEnv, db, signalId, action: OneClickAction.MARKET_OPEN, actionValues,
    traderAddress, agentAddress, agentAuthorization: snapshot.agentAuthorization,
    nonce, deadline: Math.floor(now / 1000) + 300,
    feeToken, antiDdosFee, preflight: executionPlan.preflight,
    allowanceRequirements, pairBase: snapshot.market.base,
    leverage: executionPlan.selectedLeverage, marginMon: executionPlan.marginMonUsed,
    notionalUsd: executionPlan.notionalUsd,
    payload: {
      executionPath: "1CT_HOSTED_AGENT", candidate, plan: serializable(executionPlan),
      stopRiskMon, entryBudgetMon, submittedAt: now,
    },
    now,
    dependencies: {
      ...dependencies,
      beforeSubmit: async () => {
        const fetchPrices = dependencies.fetchLatestOraclePrices || fetchLatestOraclePrices;
        const latestPrices = await fetchPrices([snapshot.market.base], { fetchImpl: dependencies.fetchImpl || fetch });
        const quoteObservedAt = Date.now();
        const latestPrice = latestPrices?.[String(snapshot.market.base).toLowerCase()];
        if (latestPrice == null) throw new Error("LEVERUP_FINAL_ORACLE_PRICE_MISSING");
        const quoteAgeMs = validateLeverUpQuoteAge(
          executionPlan.preflight.checkedAt,
          quoteObservedAt,
          Number(effectiveEnv?.LEVERUP_MAX_QUOTE_AGE_MS ?? 30_000),
        );
        const referencePrice = BigInt(executionPlan.preflight.oraclePriceRaw);
        const finalPrice = BigInt(latestPrice);
        if (referencePrice <= 0n || finalPrice <= 0n) throw new Error("LEVERUP_FINAL_ORACLE_PRICE_INVALID");
        const driftRaw = calculateLeverUpQuoteDriftBps(referencePrice, finalPrice);
        const maxDriftBps = Number(effectiveEnv?.LEVERUP_MAX_QUOTE_DRIFT_BPS ?? 10);
        if (!Number.isInteger(maxDriftBps) || maxDriftBps < 0 || maxDriftBps > 30) throw new Error("LEVERUP_MAX_QUOTE_DRIFT_CONFIG_INVALID");
        if (driftRaw > BigInt(maxDriftBps)) {
          throw new Error("LEVERUP_QUOTE_DRIFT_EXCEEDED: " + driftRaw.toString() + "bps > " + maxDriftBps + "bps; refresh the signal and rerun preflight");
        }
        const finalPlan = refreshLeverUpMarketOpenPlan({
          plan: executionPlan, pairView: snapshot.pairView, freshOraclePriceRaw: finalPrice,
          now: quoteObservedAt,
          entryPriceToleranceBps: Number(effectiveEnv?.LEVERUP_ENTRY_PRICE_TOLERANCE_BPS ?? 30),
          leverageHeadroomBps: Number(effectiveEnv?.LEVERUP_LEVERAGE_HEADROOM_BPS ?? 50),
        });
        return {
          actionValues: finalPlan.actionValues,
          preflight: finalPlan.preflight,
          payload: {
            executionPath: "1CT_HOSTED_AGENT", candidate, plan: serializable(finalPlan),
            stopRiskMon, entryBudgetMon, submittedAt: now,
            finalQuoteObservedAt: quoteObservedAt, finalQuoteAgeMs: quoteAgeMs, quoteDriftBps: driftRaw.toString(),
          },
        };
      },
    },
  });
  return { ...result, risk, executionPath: "1CT_HOSTED_AGENT" };
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
  // Protective stop always outranks the venue's ordinary minimum-hold timer.
  if (stopHit) return { action: "MARKET_CLOSE", reason: "STOP_LOSS_TRIGGERED" };
  if (earliest > nowSeconds) return { action: "WAIT", reason: "MINIMUM_HOLD_NOT_REACHED" };
  if (entry > 0n) {
    for (let i = 0; i < partialTakeProfits.length; i++) {
      if (completedPartialLevels.includes(i)) continue;
      const level = partialTakeProfits[i] || {};
      const targetPct = Number(level.targetPct), closePct = Number(level.closePct ?? level.percent);
      if (!(targetPct > 0 && targetPct < 100 && closePct > 0 && closePct < 100)) continue;
      const delta = BigInt(Math.round(targetPct * 100));
      const partialTarget = isLong ? entry * (10_000n + delta) / 10_000n : entry * (10_000n - delta) / 10_000n;
      if (isLong ? price >= partialTarget : price <= partialTarget) {
        const qty = BigInt(position.qtyRaw) * BigInt(Math.round(closePct * 100)) / 10_000n;
        if (qty > 0n && qty < BigInt(position.qtyRaw)) return { action: "PARTIAL_CLOSE", reason: "PARTIAL_TAKE_PROFIT_" + i, levelIndex: i, qtyRaw: qty.toString() };
      }
    }
  }
  if (targetHit) return { action: "MARKET_CLOSE", reason: "TAKE_PROFIT_TRIGGERED" };
  if (expired) return { action: "HOLD", reason: "MAX_HOLD_TIME_REACHED_REVIEW_REQUIRED", maxHoldReached: true };
  return { action: "HOLD", reason: "NO_EXIT_TRIGGER" };
}

async function readEntryMetadata(db) {
  if (!db?.prepare) return [];
  const result = await db.prepare("SELECT signal_id,pair_base,payload_json,status,created_at_ms FROM leverup_execution_intents WHERE action = 0 AND status IN ('EXECUTED','RECONCILED','CLOSED','SUBMITTED','PENDING','UNCERTAIN')").all();
  return (result.results || []).map((row) => {
    try { return { signalId: row.signal_id, tradeId: row.signal_id, pairBase: row.pair_base || null, intentStatus: row.status, createdAt: Number(row.created_at_ms || 0), ...JSON.parse(row.payload_json || "{}") }; }
    catch { return { signalId: row.signal_id, tradeId: row.signal_id, pairBase: row.pair_base || null, intentStatus: row.status, createdAt: Number(row.created_at_ms || 0) }; }
  });
}

export async function reconcilePendingLeverUpIntents({ env, db, now = Date.now(), dependencies = {} }) {
  if (!db?.prepare) return { checked: 0, reconciled: 0, skipped: 0, rejected: 0, uncertain: 0 };
  const pending = await db.prepare("SELECT * FROM leverup_execution_intents WHERE status IN ('SUBMITTED','PENDING') AND intent_hash IS NOT NULL ORDER BY created_at_ms ASC LIMIT 25").all();
  const rows = pending.results || [];
  if (!rows.length) return { checked: 0, reconciled: 0, skipped: 0, rejected: 0, uncertain: 0 };
  const fetchImpl = dependencies.fetchImpl || fetch;
  const statusReader = dependencies.getStatus || getIntentStatusOnce;
  const apiReader = dependencies.fetchOpenPositions || fetchOpenPositions;
  const trader = String(env?.LEVERUP_TRADER_ADDRESS || "");
  let open = [];
  try { open = await apiReader(trader, { fetchImpl }); } catch { /* retain pending; indexing/API may lag */ }
  let reconciled = 0, skipped = 0, rejected = 0, uncertain = 0;
  for (const row of rows) {
    try {
      let payload = {};
      try { payload = JSON.parse(row.payload_json || "{}"); } catch {}
      if (payload.executionPath === "ONCHAIN_NATIVE") {
        const pairBase = String(row.pair_base || payload.plan?.preflight?.pairBase || "").toLowerCase();
        const isLong = payload.candidate?.side === "LONG";
        if (!/^0x[0-9a-f]{40}$/.test(pairBase)) throw new Error("ONCHAIN_PENDING_PAIR_BASE_MISSING");
        const client = dependencies.publicClient || createLeverUpPublicClient(env?.ALCHEMY_RPC || env?.LEVERUP_RPC_URL || "https://rpc2.monad.xyz");
        const receipt = client.getTransactionReceipt
          ? await client.getTransactionReceipt({ hash: row.intent_hash }).catch(() => null)
          : null;
        if (receipt?.status === "reverted") {
          await updateIntent(db, row.signal_id, "REJECTED", {
            lastError: "ONCHAIN_MARKET_OPEN_TRANSACTION_REVERTED",
            payload: { ...payload, transactionHash: row.intent_hash, receiptBlock: String(receipt.blockNumber), failedAt: now },
          });
          rejected++; continue;
        }
        const positions = await (dependencies.readPositions || readPositionsV4)(trader, pairBase, { publicClient: client });
        const matches = (positions || []).filter((p) => Boolean(p.isLong) === isLong);
        if (matches.length === 1) {
          const position = normalizePositionAccrual(matches[0]);
          await updateIntent(db, row.signal_id, "EXECUTED", { payload: { ...payload, tradeId: row.signal_id, positionHash: position.positionHash, executedAt: now, keeperPending: false } });
          reconciled++;
        } else {
          await updateIntent(db, row.signal_id, "PENDING", { payload: { ...payload, lastPositionCheckAt: now, keeperPending: true, ambiguousPositionMatches: matches.length } });
        }
        continue;
      }
      const state = await statusReader(LEVERUP_1CT.baseUrl, row.intent_hash, { fetchImpl });
      if (state.skipped) {
        await updateIntent(db, row.signal_id, "SKIPPED", { payload: { ...payload, intentStatus: state } });
        skipped++; continue;
      }
      if (state.executed && state.success === false) {
        const failureReason = decodeLeverUpIntentFailureReason(state.reason || state.error || "LEVERUP_INTENT_EXECUTED_UNSUCCESSFULLY");
        await updateIntent(db, row.signal_id, "REJECTED", {
          lastError: failureReason,
          payload: { ...payload, intentStatus: state, failureReason, failedAt: now },
        });
        rejected++; continue;
      }
      if (!state.executed) {
        await updateIntent(db, row.signal_id, "PENDING", { payload: { ...payload, lastStatusCheckAt: now } });
        continue;
      }
      const pairBase = String(row.pair_base || payload.plan?.preflight?.pairBase || payload.plan?.pairBase || "").toLowerCase();
      const isLong = payload.candidate?.side === "LONG";
      const indexed = open.find((p) => String(p.pairBase || p.pair?.base || "").toLowerCase() === pairBase &&
        (p.isLong == null || Boolean(p.isLong) === isLong));
      if (Number(row.action) === OneClickAction.MARKET_OPEN) {
        if (!/^0x[0-9a-f]{40}$/.test(pairBase)) {
          await updateIntent(db, row.signal_id, "PENDING", { payload: { ...payload, intentStatus: state, pairBaseMissing: true } });
          continue;
        }
        const client = dependencies.publicClient || createLeverUpPublicClient(env?.ALCHEMY_RPC || env?.LEVERUP_RPC_URL || "https://rpc2.monad.xyz");
        const chainPositions = await (dependencies.readPositions || readPositionsV4)(trader, pairBase, { publicClient: client });
        const indexedHash = String(indexed?.positionHash || indexed?.position?.positionHash || "").toLowerCase();
        const chainMatches = (chainPositions || []).filter((p) => {
          if (indexedHash) return String(p.positionHash || "").toLowerCase() === indexedHash;
          return Boolean(p.isLong) === isLong;
        });
        const chainMatch = chainMatches.length === 1 ? chainMatches[0] : null;
        if (!chainMatch) {
          await updateIntent(db, row.signal_id, "PENDING", { payload: { ...payload, intentStatus: state, indexingLag: !indexed, chainMatchAmbiguous: chainMatches.length > 1 } });
          continue;
        }
        payload.tradeId = row.signal_id;
        payload.positionHash = chainMatch.positionHash;
        payload.executedAt = now;
        await updateIntent(db, row.signal_id, "EXECUTED", { payload });
        reconciled++; continue;
      }
      if (Number(row.action) === OneClickAction.MARKET_CLOSE || Number(row.action) === OneClickAction.PARTIAL_CLOSE) {
        await updateIntent(db, row.signal_id, "EXECUTED", { payload: { ...payload, intentStatus: state, executedAt: now } });
        if (Number(row.action) === OneClickAction.PARTIAL_CLOSE && Number.isInteger(Number(payload.levelIndex))) {
          const entryRows = await db.prepare("SELECT signal_id,payload_json,status FROM leverup_execution_intents WHERE action = 0 AND status IN ('EXECUTED','RECONCILED','SUBMITTED','PENDING')").all();
          for (const entryRow of entryRows.results || []) {
            let entryPayload = {};
            try { entryPayload = JSON.parse(entryRow.payload_json || "{}"); } catch {}
            if (String(entryPayload.positionHash || "").toLowerCase() !== String(payload.positionHash || "").toLowerCase()) continue;
            const levels = new Set(Array.isArray(entryPayload.completedPartialLevels) ? entryPayload.completedPartialLevels : []);
            levels.add(Number(payload.levelIndex));
            await updateIntent(db, entryRow.signal_id, entryRow.status, { payload: { ...entryPayload, completedPartialLevels: [...levels] } });
          }
        }
        reconciled++; continue;
      }
      await updateIntent(db, row.signal_id, "RECONCILED", { payload: { ...payload, intentStatus: state } });
      reconciled++;
    } catch (error) {
      await updateIntent(db, row.signal_id, "PENDING", { lastError: String(error?.message || error).slice(0, 220) }).catch(() => void 0);
      uncertain++;
    }
  }
  return { checked: rows.length, reconciled, skipped, rejected, uncertain };
}

export async function notifyLeverUpClosedTrade(env, closed, settlement, entry) {
  const token = String(env?.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = String(env?.TELEGRAM_CHAT_ID || "").trim();
  if (!token || !chatId) throw new Error("TELEGRAM_CLOSE_ALERT_NOT_CONFIGURED");
  const close = closed.closeInfo || {};
  const side = closed.isLong === true || closed.side === "LONG" ? "LONG" : closed.isLong === false || closed.side === "SHORT" ? "SHORT" : "SIDE UNKNOWN";
  const symbol = String(closed.pair || closed.symbol || entry?.candidate?.symbol || entry?.plan?.preflight?.symbol || "UNKNOWN");
  const reason = String(close.reason || close.closeReason || close.closeType || close.trigger || close.exitReason || "EXCHANGE_REPORTED_CLOSE");
  const marginToken = String(closed.marginToken || entry?.plan?.preflight?.marginToken || LEVERUP_TOKENS.LVMON).toLowerCase();
  const marginLabel = marginToken === LEVERUP_TOKENS.LVMON.toLowerCase() ? "LVMON"
    : marginToken === LEVERUP_TOKENS.WMON.toLowerCase() ? "WMON" : marginToken;
  const marginDecimals = marginToken === LEVERUP_TOKENS.USDC.toLowerCase() ? 6 : 18;
  const net = BigInt(settlement.netPnlAfterFeesRaw || "0");
  const gross = BigInt(settlement.grossPnlRaw || "0");
  const marginRaw = BigInt(entry?.plan?.actionValues?.[4] || entry?.plan?.amountInRaw || 0);
  const roi = marginRaw > 0n ? Number(net) / Number(marginRaw) * 100 : null;
  const sign = (v) => (v > 0n ? "+" : "") + (Number(v) / (10 ** marginDecimals)).toFixed(3);
  const exitPrice = (Number(settlement.closePriceRaw) / 1e18).toFixed(6);
  const lines = [
    "🔴 CIEL LIVE TRADE CLOSED",
    side + " " + symbol + " | " + reason,
    "Executed exit $" + exitPrice + " | P&L " + sign(net) + " " + marginLabel,
    "Return on margin: " + (roi === null ? "n/a" : (roi >= 0 ? "+" : "") + roi.toFixed(2) + "%") + " | signal " + String(entry?.signalId || "not linked"),
    "Gross P&L: " + sign(gross) + " " + marginLabel,
    "Trading fees: " + sign(-BigInt(settlement.totalTradingFeesRaw || "0")) + " " + marginLabel,
    "Funding: " + sign(BigInt(settlement.fundingFeeRaw || "0")) + " " + marginLabel + " | holding fee: " + sign(BigInt(settlement.holdingFeeRaw || "0")) + " " + marginLabel,
    "Net realised P&L is after recorded trading fees and funding/holding costs. Position: " + String(closed.positionHash || "unknown"),
  ];
  const response = await (env?.FETCH || fetch)("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: lines.join("\n").slice(0, 3900), disable_web_page_preview: true }),
    signal: AbortSignal.timeout(8000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok !== true) throw new Error("TELEGRAM_LIVE_CLOSE_ALERT_FAILED: " + String(payload.description || response.status).slice(0, 180));
  const messageId = payload.result?.message_id || null;
  console.log("LeverUp live close alert delivered", JSON.stringify({ positionHash: closed.positionHash || null, messageId }));
  return { messageId };
}

async function reconcileClosedSettlements({ env, db, now, dependencies = {} }) {
  if (!db?.prepare) return { checked: 0, reconciled: 0 };
  const unsettled = await db.prepare("SELECT COUNT(*) AS count FROM leverup_execution_intents WHERE action = 0 AND status IN ('EXECUTED','RECONCILED','CLOSED','SUBMITTED','PENDING')").first();
  if (!Number(unsettled?.count || 0)) return { checked: 0, reconciled: 0, noUnsettledEntries: true };
  const throttleKey = "ciel:leverup:settlement:last-check:v1";
  const lastCheck = Number(await env?.CIEL_STATE?.get(throttleKey).catch(() => "0") || 0);
  if (lastCheck && now - lastCheck < 60_000) return { checked: 0, reconciled: 0, throttled: true };
  await env?.CIEL_STATE?.put(throttleKey, String(now), { expirationTtl: 3600 }).catch(() => void 0);
  // Closed trades are newest-first. A single bounded history page is enough for close alerts
  // and avoids holding the one-minute position-manager cycle open while scanning old history.
  const historyResult = await (dependencies.fetchHistory || fetchAllPositions)(
    String(env?.LEVERUP_TRADER_ADDRESS || ""), { fetchImpl: dependencies.fetchImpl || fetch, page: 0, size: 100 });
  const history = Array.isArray(historyResult) ? historyResult : historyResult?.content;
  if (!Array.isArray(history)) throw new Error("LEVERUP_CLOSED_POSITION_HISTORY_INVALID");
  const entries = await readEntryMetadata(db);
  let reconciled = 0;
  for (const closed of history.filter((p) => p?.status === "CLOSED" && p?.closeInfo && p?.positionHash)) {
    const positionHash = String(closed.positionHash).toLowerCase();
    const closeTimeMs = Number(closed.closeInfo.closeTime || closed.closeInfo.closedAt || closed.closeInfo.timestamp || 0) * (Number(closed.closeInfo.closeTime || 0) < 10_000_000_000 ? 1000 : 1);
    const matchingEntries = entries.filter((x) => String(x.positionHash || "").toLowerCase() === positionHash)
      .filter((x) => !Number(x.executedAt || x.createdAt) || !closeTimeMs || Number(x.executedAt || x.createdAt) <= closeTimeMs)
      .sort((a,b) => Number(b.executedAt || b.createdAt || 0) - Number(a.executedAt || a.createdAt || 0));
    let entry = closeTimeMs
      ? (matchingEntries[0] || null)
      : (matchingEntries.length === 1 ? matchingEntries[0] : null);
    // If the exchange omits close time and this hash has multiple entry instances,
    // leave the settlement unlinked rather than attributing it to the wrong trade.
    if (!entry && matchingEntries.length === 0) {
      const closedEntry = await db.prepare(`SELECT signal_id,pair_base,payload_json,status,created_at_ms
        FROM leverup_execution_intents
        WHERE action = 0 AND lower(json_extract(payload_json, '$.positionHash')) = ?
        ORDER BY created_at_ms DESC LIMIT 1`).bind(positionHash).first();
      if (closedEntry) {
        entry = { signalId: closedEntry.signal_id, tradeId: closedEntry.signal_id, pairBase: closedEntry.pair_base || null,
          createdAt: Number(closedEntry.created_at_ms || 0), intentStatus: closedEntry.status,
          ...serializable(JSON.parse(closedEntry.payload_json || "{}")) };
      }
    }
    const tradeId = leverUpTradeInstanceId(entry) || ("legacy:" + positionHash + ":" + String(closed.closeInfo.closeTime || closed.closeInfo.timestamp || "unknown"));
    const existing = await db.prepare("SELECT trade_id FROM leverup_trade_settlements WHERE trade_id = ?")
      .bind(tradeId).first();
    const latest = await db.prepare("SELECT * FROM leverup_position_fee_snapshots WHERE position_hash = ? AND observed_at_ms >= ? ORDER BY observed_at_ms DESC LIMIT 1")
      .bind(positionHash, Number(entry?.executedAt || entry?.createdAt || 0)).first();
    const lastSnapshot = latest ? {
      fundingFeeRaw: latest.funding_fee_raw, holdingFeeRaw: latest.holding_fee_raw,
    } : null;
    const settlement = reconcileClosedPosition(closed, lastSnapshot, entry?.plan?.preflight || null, {
      marginTokenDecimals: 18, marginTokenPriceUsd: null,
    });
    const entryOpenedAt = Number(entry?.executedAt || entry?.createdAt || 0);
    const closeIntent = await db.prepare(`SELECT signal_id,payload_json,status FROM leverup_execution_intents
      WHERE action IN (1,9) AND (
        json_extract(payload_json, '$.tradeId') = ?
        OR (? > 0 AND lower(json_extract(payload_json, '$.positionHash')) = ? AND created_at_ms >= ?)
      ) ORDER BY created_at_ms DESC LIMIT 1`)
      .bind(tradeId, entryOpenedAt, positionHash, entryOpenedAt).first().catch(() => null);
    let closeIntentPayload = {};
    try { closeIntentPayload = JSON.parse(closeIntent?.payload_json || "{}"); } catch {}
    const exchangeCloseReason = closed.closeInfo?.reason || closed.closeInfo?.closeReason || closed.closeInfo?.closeType || closed.closeInfo?.trigger || closed.closeInfo?.exitReason;
    const closeReason = String(exchangeCloseReason || closeIntentPayload.reason || "EXCHANGE_REPORTED_CLOSE");
    const closeForNotification = { ...closed, closeInfo: { ...closed.closeInfo, reason: closeReason } };
    if (!existing) {
      await persistSettlementReconciliation(db, settlement, {
        tradeId,
        intentSignalId: entry?.signalId || null, closeIntentSignalId: closeIntent?.signal_id || null,
        closeIntentStatus: closeIntent?.status || null, source: "LeverUp closed-position history",
        closeReason,
        estimatedProtocolCosts: entry?.plan?.preflight?.estimatedProtocolCosts || null,
      });
      if (entry?.signalId) await updateIntent(db, entry.signalId, "RECONCILED", {
        payload: { ...entry, settlement: serializable(settlement), reconciledAt: now },
      });
      reconciled++;
    } else {
      // Backfill the original settlement row with its signal and close reason.
      await db.prepare("UPDATE leverup_trade_settlements SET source_json = json_patch(COALESCE(source_json, '{}'), ?) WHERE trade_id = ?")
        .bind(JSON.stringify({ intentSignalId: entry?.signalId || null, closeIntentSignalId: closeIntent?.signal_id || null, closeIntentStatus: closeIntent?.status || null, closeReason }), tradeId).run();
    }
    // Settlement persistence and Telegram delivery are separate idempotent steps.
    // A prior DB write must not suppress a notification that failed or was skipped.
    const notificationKey = "ciel:leverup:close-notified:v2:" + tradeId;
    const alreadyNotified = await env?.CIEL_STATE?.get(notificationKey).catch(() => null);
    if (!alreadyNotified) {
      try {
        const delivery = await notifyLeverUpClosedTrade(env, closeForNotification, settlement, entry);
        await env?.CIEL_STATE?.put(notificationKey, JSON.stringify({ sentAt: now, messageId: delivery?.messageId || null }), { expirationTtl: 365 * 24 * 3600 });
      } catch (error) {
        console.error("LeverUp live close notification failed: " + String(error?.message || error).slice(0, 250));
      }
    }
  }
  return { checked: history.length, reconciled };
}

export function collectLeverUpPairBases(apiPositions = [], entries = []) {
  return [...new Set([
    ...apiPositions.map((p) => String(p?.pairBase || p?.pair?.base || "").toLowerCase()),
    ...entries.map((entry) => String(entry?.pairBase || entry?.plan?.preflight?.pairBase || entry?.plan?.pairBase || "").toLowerCase()),
  ].filter((base) => /^0x[0-9a-f]{40}$/.test(base)))];
}

function normalizeLeverUpPurgeSymbol(value) {
  return String(value || "").trim().toUpperCase()
    .replace(/\.(P|PERP)$/,"")
    .replace(/[-_/](USD|USDT|USDC|PERP)$/,"")
    .replace(/(USDT|USDC|USD|PERP)$/,"")
    .replace(/[^A-Z0-9]/g,"");
}

function pairMatchesPurgeSymbol(pair, symbol) {
  if (!symbol) return true;
  const values = [pair?.symbol, pair?.pairName, pair?.name, pair?.ticker, pair?.baseSymbol,
    (typeof pair?.pair === "string" ? pair.pair : null), pair?.pair?.symbol, pair?.pair?.name, pair?.baseToken?.symbol];
  return values.some((value) => normalizeLeverUpPurgeSymbol(value) === symbol);
}

export async function purgeLeverUpPositions({ env, db, symbol = null, now = Date.now(), dependencies = {} }) {
  const requestedSymbol = normalizeLeverUpPurgeSymbol(symbol);
  if (symbol && !requestedSymbol) return { status: "INVALID_SYMBOL", checked: 0, submitted: 0 };
  const traderAddress = String(env?.LEVERUP_TRADER_ADDRESS || "");
  const agentAddress = String(env?.LEVERUP_AGENT_ADDRESS || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(traderAddress) || !/^0x[0-9a-fA-F]{40}$/.test(agentAddress)) {
    return { status: "BLOCKED_WALLET_CONFIGURATION", checked: 0, submitted: 0 };
  }
  const fetchImpl = dependencies.fetchImpl || fetch;
  const client = dependencies.publicClient || createLeverUpPublicClient(env?.ALCHEMY_RPC || env?.LEVERUP_RPC_URL || "https://rpc2.monad.xyz");
  let pairs = [], apiPositions = [], pairDiscoveryError = null;
  try { pairs = await (dependencies.fetchPairs || fetchLeverUpPairs)({ fetchImpl }); }
  catch (error) { pairDiscoveryError = String(error?.message || error).slice(0, 180); }
  try { apiPositions = await (dependencies.fetchOpenPositions || fetchOpenPositions)(traderAddress, { fetchImpl }); }
  catch { /* on-chain market scan below remains authoritative */ }
  const selectedPairs = (pairs || []).filter((pair) => pairMatchesPurgeSymbol(pair, requestedSymbol));
  if (requestedSymbol && !selectedPairs.length && !(apiPositions || []).some((p) =>
    normalizeLeverUpPurgeSymbol(p?.symbol || p?.pair?.symbol || p?.pair?.name || p?.pairName) === requestedSymbol)) {
    return { status: "UNKNOWN_TOKEN", requestedSymbol, checked: 0, submitted: 0, discoveryError: pairDiscoveryError };
  }
  const bases = [...new Set([
    ...selectedPairs.map((pair) => String(pair?.base || pair?.pairBase || "").toLowerCase()),
    ...(apiPositions || []).filter((p) => pairMatchesPurgeSymbol(p, requestedSymbol))
      .map((p) => String(p?.pairBase || p?.pair?.base || "").toLowerCase()),
  ].filter((base) => /^0x[0-9a-f]{40}$/.test(base)))];
  if (!bases.length) return { status: pairDiscoveryError ? "DISCOVERY_FAILED" : "NO_MARKETS_FOUND", requestedSymbol, checked: 0, submitted: 0, discoveryError: pairDiscoveryError };
  const pairMeta = new Map();
  for (const pair of selectedPairs) {
    const base = String(pair?.base || pair?.pairBase || "").toLowerCase();
    if (base) pairMeta.set(base, pair);
  }
  const concurrency = 8;
  const positionMap = new Map(), pairViews = new Map(), readErrors = [];
  for (let i = 0; i < bases.length; i += concurrency) {
    const batch = bases.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(async (base) => {
      try {
        const [rows, pairView] = await Promise.all([
          (dependencies.readPositions || readPositionsV4)(traderAddress, base, { publicClient: client }),
          (dependencies.readPair || readPairByBaseV4)(base, { publicClient: client }),
        ]);
        return { base, rows, pairView };
      } catch (error) { return { base, error: String(error?.message || error).slice(0, 160) }; }
    }));
    for (const result of results) {
      if (result.error) { readErrors.push({ pairBase: result.base, reason: result.error }); continue; }
      pairViews.set(result.base, result.pairView);
      for (const row of result.rows || []) {
        let qty = 0n;
        try { qty = BigInt(row.qty ?? row.qtyRaw ?? 0); } catch {}
        if (qty <= 0n || !/^0x[0-9a-fA-F]{64}$/.test(String(row.positionHash || ""))) continue;
        const position = normalizePositionAccrual(row);
        positionMap.set(position.positionHash.toLowerCase(), {
          ...position, pairBase: result.base,
          purgeSymbol: pairMeta.get(result.base)?.symbol || pairMeta.get(result.base)?.pairName || pairMeta.get(result.base)?.name || null,
        });
      }
    }
  }
  const positions = [...positionMap.values()];
  if (!positions.length) return {
    status: readErrors.length ? "PARTIAL_DISCOVERY_NO_POSITIONS" : "NO_OPEN_POSITIONS",
    requestedSymbol, checked: bases.length, submitted: 0, openPositionCount: 0, readErrors,
  };
  const purgeLiveEnabled = String(env?.LEVERUP_PURGE_LIVE_ENABLED).toLowerCase() === "true";
  if (String(env?.LEVERUP_LIVE_TRADING).toLowerCase() !== "true" && !purgeLiveEnabled) {
    return { status: "LIVE_DISABLED", requestedSymbol, checked: bases.length, submitted: 0, openPositionCount: positions.length,
      positions: positions.map((p) => ({ symbol: p.purgeSymbol, positionHash: p.positionHash })) };
  }
  if (!db?.prepare) return { status: "BLOCKED_D1_LEDGER_UNAVAILABLE", requestedSymbol, checked: bases.length, submitted: 0, openPositionCount: positions.length };
  const [auth, antiDdos] = await Promise.all([
    (dependencies.readAuthorization || readAgentAuthorization)(traderAddress, agentAddress, { publicClient: client }),
    (dependencies.fetchAntiDdos || fetchAntiDdosConfig)({ fetchImpl }),
  ]);
  if (!auth?.authorized || !auth.canMarketClose) {
    return { status: "BLOCKED_CLOSE_PERMISSION_MISSING", requestedSymbol, checked: bases.length, submitted: 0, openPositionCount: positions.length };
  }
  const feeTokens = (antiDdos.config || []).filter((item) => item.enabled && item.feeToken).map((item) => item.feeToken);
  const balances = await (dependencies.readBalances || readTokenBalancesAndAllowances)(traderAddress, feeTokens, { publicClient: client });
  let nextNonce = BigInt(await (dependencies.readNonce || readLastAgentNonce)(traderAddress, agentAddress, { publicClient: client })) + 1n;
  let submitted = 0;
  const results = [];
  const purgeEntries = await readEntryMetadata(db).catch(() => []);
  for (const position of positions) {
    const pairView = pairViews.get(position.pairBase);
    if (!pairView?.slippageConfig?.enabled) {
      results.push({ symbol: position.purgeSymbol, positionHash: position.positionHash, status: "SKIPPED", reason: "CLOSE_SLIPPAGE_CONFIG_UNAVAILABLE" });
      continue;
    }
    try {
      const oneClickAction = OneClickAction.MARKET_CLOSE;
      const slippage = BigInt(position.isLong ? pairView.slippageConfig.slippageLongP : pairView.slippageConfig.slippageShortP);
      const actionValues = [position.positionHash, slippage];
      const fee = selectFeeToken(oneClickAction, antiDdos.config, balances, [], { requireAllowance: false });
      const nonce = nextNonce;
      nextNonce += 1n;
      const linkedEntry = purgeEntries.filter((entry) => String(entry.positionHash || "").toLowerCase() === position.positionHash.toLowerCase())
        .sort((a,b) => Number(b.executedAt || b.createdAt || 0) - Number(a.executedAt || a.createdAt || 0))[0] || null;
      const tradeId = leverUpTradeInstanceId(linkedEntry) || ("unlinked:" + position.positionHash.toLowerCase() + ":" + now);
      const signalId = "manual-purge-" + tradeId + "-" + now;
      const result = await submitLeverUpIntent({
        env, db, signalId, action: oneClickAction, actionValues, traderAddress, agentAddress,
        agentAuthorization: auth, nonce: nonce.toString(), deadline: Math.floor(now / 1000) + 300,
        feeToken: fee.feeToken, antiDdosFee: fee.antiDdosFee,
        allowanceRequirements: fee.feeToken.toLowerCase() === ZERO.toLowerCase() ? [] : [{ tokenAddress: fee.feeToken, amount: fee.antiDdosFee }],
        pairBase: position.pairBase,
        payload: { tradeId, positionHash: position.positionHash, action: "MANUAL_PURGE", requestedSymbol, symbol: position.purgeSymbol },
        now, dependencies, allowRiskReducingClose: true,
      });
      if (result.submitted) submitted++;
      results.push({ symbol: position.purgeSymbol, positionHash: position.positionHash, status: result.status, intentHash: result.intentHash || null, reason: result.reason || null });
    } catch (error) {
      results.push({ symbol: position.purgeSymbol, positionHash: position.positionHash, status: "FAILED", reason: String(error?.message || error).slice(0, 180) });
    }
  }
  return {
    status: submitted === positions.length ? "SUBMITTED" : (submitted ? "PARTIAL" : "NO_CLOSES_SUBMITTED"),
    requestedSymbol, checked: bases.length, submitted, openPositionCount: positions.length,
    killSwitchBypassedForRiskReducingClose: String(env?.LEVERUP_KILL_SWITCH).toLowerCase() === "true",
    purgeOnlyMode: purgeLiveEnabled && String(env?.LEVERUP_LIVE_TRADING).toLowerCase() !== "true",
    results, readErrors,
  };
}

export async function runLeverUpPositionManager({ env, db, now = Date.now(), dependencies = {} }) {
  const liveOverride = env?.CIEL_STATE && typeof env.CIEL_STATE.get === "function"
    ? await env.CIEL_STATE.get("ciel:control:live-enabled")
    : null;
  if (liveOverride != null) env = { ...env, LEVERUP_LIVE_TRADING: liveOverride };
  const reconciliation = await reconcilePendingLeverUpIntents({ env, db, now, dependencies });
  const traderAddress = String(env?.LEVERUP_TRADER_ADDRESS || "");
  const agentAddress = String(env?.LEVERUP_AGENT_ADDRESS || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(traderAddress) || !/^0x[0-9a-fA-F]{40}$/.test(agentAddress)) {
    return { status: "BLOCKED_WALLET_CONFIGURATION", checked: 0, submitted: 0 };
  }
  const fetchImpl = dependencies.fetchImpl || fetch;
  const client = dependencies.publicClient || createLeverUpPublicClient(env?.ALCHEMY_RPC || env?.LEVERUP_RPC_URL || "https://rpc2.monad.xyz");
  let apiPositions = [];
  let positionIndexError = null;
  try { apiPositions = await (dependencies.fetchOpenPositions || fetchOpenPositions)(traderAddress, { fetchImpl }); }
  catch (error) { positionIndexError = errorMessage(error); }
  const entries = await readEntryMetadata(db);
  const pairBases = collectLeverUpPairBases(apiPositions, entries);
  if (!pairBases.length && positionIndexError) {
    return { status: "BLOCKED_POSITION_DISCOVERY", checked: 0, submitted: 0, reconciliation, discoveryError: positionIndexError };
  }
  if (!pairBases.length) {
    const settlements = await reconcileClosedSettlements({ env, db, now, dependencies })
      .catch((error) => ({ error: String(error?.message || error).slice(0, 200) }));
    return { status: liveEnabled(env) ? "LIVE_MONITORING" : "READ_ONLY_MONITORING", checked: 0, submitted: 0, reconciliation, settlements, discovery: "NO_KNOWN_PAIR_BASES" };
  }
  const [prices, antiDdos, auth] = await Promise.all([
    (dependencies.fetchPrices || fetchLatestOraclePrices)(pairBases, { fetchImpl }),
    (dependencies.fetchAntiDdos || fetchAntiDdosConfig)({ fetchImpl }),
    (dependencies.readAuthorization || readAgentAuthorization)(traderAddress, agentAddress, { publicClient: client }),
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
  // If the indexer has not published the opened position yet, associate only a unique
  // on-chain pair+side match with its submitted CIEL entry. Ambiguous matches stay untouched.
  for (const entry of entries) {
    if (entry.positionHash) continue;
    const base = String(entry.pairBase || entry.plan?.preflight?.pairBase || entry.plan?.pairBase || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(base)) continue;
    const matches = [...positionMap.entries()].filter(([, position]) =>
      position.pairBase === base && Boolean(position.isLong) === (entry.candidate?.side === "LONG"));
    if (matches.length !== 1) continue;
    const [hash, position] = matches[0];
    entry.positionHash = position.positionHash;
    entry.executedAt = entry.executedAt || now;
    await updateIntent(db, entry.signalId, "EXECUTED", { payload: entry });
  }
  // Release an entry slot only after the on-chain pair read confirms its position is gone.
  for (const entry of entries) {
    const hash = String(entry.positionHash || "").toLowerCase();
    if (!['EXECUTED','RECONCILED'].includes(entry.intentStatus) || !/^0x[0-9a-f]{64}$/.test(hash) || positionMap.has(hash)) continue;
    await updateIntent(db, entry.signalId, "RECONCILED", {
      payload: { ...entry, closedAt: now, closeReconciledByOnchainPositionRead: true },
    });
  }
  const pairMap = new Map(pairViews);
  const feeTokens = (antiDdos.config || []).filter((x) => x.enabled && x.feeToken).map((x) => x.feeToken);
  const balances = await (dependencies.readBalances || readTokenBalancesAndAllowances)(traderAddress, feeTokens, { publicClient: client });
  let submitted = 0, snapshots = 0, evaluated = 0, adaptiveUpdatesBlocked = 0, closePermissionBlocked = 0, aiReviewed = 0, aiCloseSignals = 0, positionsMissingPairView = 0, positionsMissingOraclePrice = 0, geminiConfiguredKeyCount = 0;
  const aiReviewStatusCounts = {};
  const aiReviewFailures = [];
  for (const [hash, position] of positionMap) {
    evaluated++;
    const pairView = pairMap.get(position.pairBase);
    if (!pairView) { positionsMissingPairView++; continue; }
    const latestPrice = prices[position.pairBase];
    if (!latestPrice) { positionsMissingOraclePrice++; continue; }
    const saved = entries.filter((x) => String(x.positionHash || "").toLowerCase() === hash)
      .sort((a,b) => Number(b.executedAt || b.createdAt || 0) - Number(a.executedAt || a.createdAt || 0))[0] || null;
    const tradeId = leverUpTradeInstanceId(saved) || ("unlinked:" + hash + ":" + String(position.timestamp || "unknown"));
    // Every on-chain position in the configured trading wallet is managed, even if
    // its original entry metadata is missing. Fixed on-chain SL/TP remain authoritative.
    const candidate = saved?.candidate || {};
    const partials = Array.isArray(candidate.partialTakeProfits) ? candidate.partialTakeProfits : [];
    const completed = Array.isArray(saved?.completedPartialLevels) ? saved.completedPartialLevels : [];
    const fixedAction = evaluateLeverUpPositionAction({
      position, currentPriceRaw: latestPrice, now,
      // Preserve the existing CIEL hold cap for ledger-linked entries. For an
      // unlinked/manual position, enforce SL/TP and adaptive protection without
      // inventing a max-hold policy that was never attached to that position.
      maxHoldMinutes: saved ? Number(candidate.holdMinutes || 180) : 0,
      partialTakeProfits: partials, completedPartialLevels: completed,
    });
    const adaptiveKey = "ciel:leverup:adaptive-exit:v2:" + tradeId;
    let adaptiveState = null;
    try { adaptiveState = await env?.CIEL_STATE?.get(adaptiveKey, "json"); } catch {}
    const adaptive = evaluateAdaptiveLeverUpExit({ position, currentPriceRaw: latestPrice, state: adaptiveState || {}, pairView, now });
    if (adaptive?.state && env?.CIEL_STATE?.put) {
      await env.CIEL_STATE.put(adaptiveKey, JSON.stringify(adaptive.state), { expirationTtl: 7 * 24 * 3600 }).catch(() => void 0);
    }
    let aiReview = { status: "SKIPPED_NO_KEYS", action: "HOLD", confidence: 0 };
    if (String(env?.GEMINI_API_KEYS || "").trim()) {
      aiReview = await reviewLeverUpPositionWithGemini({
        env, position: { ...position, symbol: pairView.symbol || pairView.pairName || null },
        currentPriceRaw: latestPrice, adaptive, state: adaptive?.state || adaptiveState || {}, now,
        maxHoldReached: fixedAction.maxHoldReached === true,
        positionAgeMinutes: Number.isFinite(Number(position.timestamp)) && Number(position.timestamp) > 0
          ? Math.max(0, (now - Number(position.timestamp) * 1000) / 60_000) : null,
        dependencies
      }).catch((error) => ({ status: "FAILED", action: "HOLD", confidence: 0, reason: String(error?.message || error).slice(0, 180) }));
    }
    aiReviewStatusCounts[aiReview.status] = (aiReviewStatusCounts[aiReview.status] || 0) + 1;
    geminiConfiguredKeyCount = Math.max(geminiConfiguredKeyCount, Number(aiReview.configuredKeyCount || 0));
    if (aiReview.status === "FAILED" && aiReviewFailures.length < 5) {
      aiReviewFailures.push(String(aiReview.reason || "GEMINI_REVIEW_FAILED").slice(0, 180));
    }
    // AI is advisory, never allowed to override fixed SL/TP or act without local
    // reversal evidence. The max-hold timer is a review checkpoint, not a forced exit.
    // A confirmed reversal closes the old position; an opposite entry still passes
    // market, collateral, authorization and portfolio-risk checks.
    if (aiReview.status === "REVIEWED") aiReviewed++;
    const aiCloseConfirmed = ["CLOSE", "REVERSE"].includes(aiReview.action) &&
      Number(aiReview.confidence) >= 85 && aiReview.reversalConfirmed === true &&
      Number(adaptive.closeScore || 0) >= 2;
    if (aiCloseConfirmed) aiCloseSignals++;
    // Hard stop / fixed exits outrank all adaptive and AI decisions.
    const minimumHoldActive = BigInt(position.earliestCloseTime || 0) > BigInt(Math.floor(now / 1000));
    const action = fixedAction.action === "MARKET_CLOSE" || fixedAction.action === "PARTIAL_CLOSE"
      ? fixedAction
      : adaptive.action === "MARKET_CLOSE" && minimumHoldActive
        ? { action: "WAIT", reason: "MINIMUM_HOLD_NOT_REACHED_FOR_ADAPTIVE_EXIT" }
        : adaptive.action === "MARKET_CLOSE" || adaptive.action === "UPDATE_TP_SL"
          ? adaptive
          : aiCloseConfirmed && !minimumHoldActive
            ? { action: "MARKET_CLOSE", reason: "GEMINI_CONFIRMED_REVERSAL_" + aiReview.action, aiReview }
            : fixedAction;
    if (db?.prepare) {
      const stored = await (dependencies.persistFeeSnapshot || persistPositionFeeSnapshot)(db, position, null, 300_000);
      if (stored?.stored) snapshots++;
    }
    if (!liveEnabled(env) || action.action === "HOLD" || action.action === "WAIT") continue;
    if (action.action === "MARKET_CLOSE" && !auth.canMarketClose) { closePermissionBlocked++; continue; }
    if (action.action === "PARTIAL_CLOSE" && !auth.canPartialClose) { closePermissionBlocked++; continue; }
    if (action.action === "UPDATE_TP_SL" && !auth.canUpdateTpSl) { adaptiveUpdatesBlocked++; continue; }
    const oneClickAction = action.action === "PARTIAL_CLOSE" ? OneClickAction.PARTIAL_CLOSE
      : action.action === "UPDATE_TP_SL" ? OneClickAction.UPDATE_TP_SL : OneClickAction.MARKET_CLOSE;
    const slippage = BigInt(position.isLong ? pairView.slippageConfig.slippageLongP : pairView.slippageConfig.slippageShortP);
    const actionValues = action.action === "PARTIAL_CLOSE"
      ? [position.positionHash, BigInt(action.qtyRaw), slippage]
      : action.action === "UPDATE_TP_SL"
        ? [position.positionHash, BigInt(action.stopLossRaw), BigInt(action.takeProfitRaw)]
        : [position.positionHash, slippage];
    const fee = selectFeeToken(oneClickAction, antiDdos.config, balances, [], { requireAllowance: false });
    const nonce = await (dependencies.readNonce || readLastAgentNonce)(traderAddress, agentAddress, { publicClient: client });
    const signalId = "position-" + tradeId + "-" + action.action.toLowerCase() +
      (action.levelIndex == null ? "" : "-" + action.levelIndex) +
      (action.action === "UPDATE_TP_SL" ? "-" + String(action.stopLossRaw) : "");
    const result = await submitLeverUpIntent({
      env, db, signalId, action: oneClickAction, actionValues, traderAddress, agentAddress,
      agentAuthorization: auth, nonce: (BigInt(nonce) + 1n).toString(), deadline: Math.floor(now / 1000) + 300,
      feeToken: fee.feeToken, antiDdosFee: fee.antiDdosFee,
      allowanceRequirements: fee.feeToken.toLowerCase() === ZERO.toLowerCase() ? [] : [{ tokenAddress: fee.feeToken, amount: fee.antiDdosFee }],
      pairBase: position.pairBase, payload: { tradeId, positionHash: position.positionHash, action: action.action, reason: action.reason, levelIndex: action.levelIndex ?? null, stopLossRaw: action.stopLossRaw ?? null,
        aiReview: { status: aiReview.status, action: aiReview.action, confidence: aiReview.confidence, reversalConfirmed: aiReview.reversalConfirmed === true, reason: aiReview.reason || null, model: aiReview.model || null, configuredKeyCount: aiReview.configuredKeyCount || 0 },
        adaptiveMetrics: { action: adaptive.action, reason: adaptive.reason, samples: adaptive.samples ?? adaptive.state?.history?.length ?? null, atrProxyPct: adaptive.atrProxyPct ?? null, trendPct: adaptive.trendPct ?? null, momentumPct: adaptive.momentumPct ?? null, closeScore: adaptive.closeScore ?? null, favourablePct: adaptive.favourablePct ?? null, peakFavourablePct: adaptive.peakFavourablePct ?? null, givebackPct: adaptive.givebackPct ?? null, profitProtection: adaptive.state?.profitProtection || null } },
      now, dependencies,
    });
    if (result.submitted) submitted++;
  }
  const settlements = await reconcileClosedSettlements({ env, db, now, dependencies })
    .catch((error) => ({ error: String(error?.message || error).slice(0, 200) }));
  return { status: liveEnabled(env) ? "LIVE_MONITORING" : "READ_ONLY_MONITORING", checked: evaluated, submitted, snapshots, adaptiveUpdatesBlocked, closePermissionBlocked, aiReviewed, aiCloseSignals, aiReviewStatusCounts, aiReviewFailures, geminiConfiguredKeyCount, positionsMissingPairView, positionsMissingOraclePrice, canMarketClose: Boolean(auth.canMarketClose), canUpdateTpSl: Boolean(auth.canUpdateTpSl), openPositionCount: positionMap.size, pairBasesChecked: pairBases.length, reconciliation, settlements };
}
