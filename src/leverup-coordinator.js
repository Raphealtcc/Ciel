// Durable, idempotent LeverUp 1CT execution and position lifecycle.
import { evaluateLeverUpPortfolioRisk } from "./leverup-risk.js";
import {
  LEVERUP_1CT, OneClickAction, getIntentStatusOnce, selectFeeToken, signAndSubmitIntent,
} from "./leverup-1ct.js";
import { ensureLeverUpTokenAllowance } from "./leverup-approval.js";
import {
  LEVERUP_TOKENS, createLeverUpPublicClient, fetchOpenPositions, fetchAllPositionsPaginated, fetchLeverUpPairs,
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
  notionalUsd = null, payload = {}, now = Date.now(), dependencies = {}, allowRiskReducingClose = false,
}) {
  const closeOnly = Number(action) === OneClickAction.MARKET_CLOSE || Number(action) === OneClickAction.PARTIAL_CLOSE;
  const emergencyCloseEnabled = allowRiskReducingClose && closeOnly && String(env?.LEVERUP_LIVE_TRADING).toLowerCase() === "true";
  if (!liveEnabled(env) && !emergencyCloseEnabled) return { status: "LIVE_DISABLED", submitted: false };
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
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(result.intentHash || ""))) {
      return { status: "UNCERTAIN", submitted: true, signalId, reason: "SUBMISSION_RESPONSE_MISSING_VALID_INTENT_HASH" };
    }
    try {
      await updateIntent(db, signalId, "SUBMITTED", { intentHash: result.intentHash,
        payload: { ...payload, action, actionValues: serializable(actionValues), intentDigest: result.intent?.actionDataHash || null } });
    } catch (ledgerError) {
      // The order may already be live. Keep the pre-submit UNCERTAIN claim and never replay it.
      return { status: "UNCERTAIN", submitted: true, intentHash: result.intentHash, signalId,
        reason: "SUBMISSION_ACCEPTED_BUT_D1_STATUS_WRITE_FAILED: " + String(ledgerError?.message || ledgerError).slice(0, 180) };
    }
    return { status: "SUBMITTED", submitted: true, intentHash: result.intentHash, signalId };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 300);
    await updateIntent(db, signalId, markedUncertain ? "UNCERTAIN" : "REJECTED", { lastError: message }).catch(() => void 0);
    return { status: markedUncertain ? "UNCERTAIN" : "REJECTED", submitted: false, signalId, reason: message };
  }
}

async function readPortfolioRiskFromLedger(db, now) {
  if (!db?.prepare) throw new Error("LEVERUP_RISK_LEDGER_UNAVAILABLE");
  const dayStartSeconds = Math.floor(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) / 1000);
  const [daily, history] = await Promise.all([
    db.prepare("SELECT net_pnl_after_fees_raw FROM leverup_settlement_reconciliations WHERE close_time >= ? ORDER BY close_time ASC")
      .bind(dayStartSeconds).all(),
    db.prepare("SELECT net_pnl_after_fees_raw FROM leverup_settlement_reconciliations ORDER BY close_time DESC LIMIT 300").all(),
  ]);
  const toMon = (raw) => Number(BigInt(raw || "0")) / 1e18;
  const dailyRealizedLossMon = (daily.results || []).reduce((sum, row) => sum + Math.max(0, -toMon(row.net_pnl_after_fees_raw)), 0);
  let equity = 0, peak = 0, rollingDrawdownMon = 0;
  for (const row of [...(history.results || [])].reverse()) {
    equity += toMon(row.net_pnl_after_fees_raw);
    peak = Math.max(peak, equity);
    rollingDrawdownMon = Math.max(rollingDrawdownMon, peak - equity);
  }
  return { dailyRealizedLossMon, rollingDrawdownMon, source: "leverup_settlement_reconciliations" };
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
  const portfolioRisk = await readPortfolioRiskFromLedger(db, now);
  const risk = evaluateLeverUpPortfolioRisk({
    requestedLeverage: plan.selectedLeverage,
    totalAllocationMon: env.LEVERUP_TOTAL_ALLOCATION_MON ?? 50,
    reserveMon: env.LEVERUP_RESERVE_MON ?? 25,
    availableWmonMon: wmonBalance, requestedMarginMon: margin, entryBudgetMon: entryBudget,
    currentOpenPositions: snapshot.indexedPositions || [],
    maxConcurrentPositions: env.LEVERUP_MAX_CONCURRENT_POSITIONS ?? 1,
    proposedStopRiskMon: stopRiskMon, aggregateStopRiskMon: 0,
    maxAggregateStopRiskMon: env.LEVERUP_MAX_AGGREGATE_STOP_RISK_MON ?? 1,
    dailyRealizedLossMon: portfolioRisk.dailyRealizedLossMon,
    maxDailyRealizedLossMon: env.LEVERUP_MAX_DAILY_LOSS_MON ?? 1,
    rollingDrawdownMon: portfolioRisk.rollingDrawdownMon,
    maxRollingDrawdownMon: env.LEVERUP_MAX_DRAWDOWN_MON ?? 2,
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
  if (expired) return { action: "MARKET_CLOSE", reason: "MAX_HOLD_TIME_REACHED" };
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
  return { action: "HOLD", reason: "NO_EXIT_TRIGGER" };
}

async function readEntryMetadata(db) {
  if (!db?.prepare) return [];
  const result = await db.prepare("SELECT signal_id,pair_base,payload_json,status FROM leverup_execution_intents WHERE action = 0 AND status IN ('EXECUTED','SUBMITTED','PENDING','UNCERTAIN')").all();
  return (result.results || []).map((row) => {
    try { return { signalId: row.signal_id, pairBase: row.pair_base || null, intentStatus: row.status, ...JSON.parse(row.payload_json || "{}") }; }
    catch { return { signalId: row.signal_id, pairBase: row.pair_base || null, intentStatus: row.status }; }
  });
}

export async function reconcilePendingLeverUpIntents({ env, db, now = Date.now(), dependencies = {} }) {
  if (!db?.prepare) return { checked: 0, reconciled: 0, skipped: 0, uncertain: 0 };
  const pending = await db.prepare("SELECT * FROM leverup_execution_intents WHERE status IN ('SUBMITTED','PENDING') AND intent_hash IS NOT NULL ORDER BY created_at_ms ASC LIMIT 25").all();
  const rows = pending.results || [];
  if (!rows.length) return { checked: 0, reconciled: 0, skipped: 0, uncertain: 0 };
  const fetchImpl = dependencies.fetchImpl || fetch;
  const statusReader = dependencies.getStatus || getIntentStatusOnce;
  const apiReader = dependencies.fetchOpenPositions || fetchOpenPositions;
  const trader = String(env?.LEVERUP_TRADER_ADDRESS || "");
  let open = [];
  try { open = await apiReader(trader, { fetchImpl }); } catch { /* retain pending; indexing/API may lag */ }
  let reconciled = 0, skipped = 0, uncertain = 0;
  for (const row of rows) {
    try {
      const state = await statusReader(LEVERUP_1CT.baseUrl, row.intent_hash, { fetchImpl });
      let payload = {};
      try { payload = JSON.parse(row.payload_json || "{}"); } catch {}
      if (state.skipped) {
        await updateIntent(db, row.signal_id, "SKIPPED", { payload: { ...payload, intentStatus: state } });
        skipped++; continue;
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
        const client = dependencies.publicClient || createLeverUpPublicClient(env?.LEVERUP_RPC_URL || "https://rpc.monad.xyz");
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
  return { checked: rows.length, reconciled, skipped, uncertain };
}

async function reconcileClosedSettlements({ env, db, now, dependencies = {} }) {
  if (!db?.prepare) return { checked: 0, reconciled: 0 };
  const unsettled = await db.prepare("SELECT COUNT(*) AS count FROM leverup_execution_intents WHERE action = 0 AND status IN ('EXECUTED','SUBMITTED','PENDING')").first();
  if (!Number(unsettled?.count || 0)) return { checked: 0, reconciled: 0, noUnsettledEntries: true };
  const throttleKey = "ciel:leverup:settlement:last-check:v1";
  const lastCheck = Number(await env?.CIEL_STATE?.get(throttleKey).catch(() => "0") || 0);
  if (lastCheck && now - lastCheck < 60_000) return { checked: 0, reconciled: 0, throttled: true };
  await env?.CIEL_STATE?.put(throttleKey, String(now), { expirationTtl: 3600 }).catch(() => void 0);
  const history = await (dependencies.fetchHistory || fetchAllPositionsPaginated)(
    String(env?.LEVERUP_TRADER_ADDRESS || ""), { fetchImpl: dependencies.fetchImpl || fetch, size: 100, maxPages: 10 });
  const entries = await readEntryMetadata(db);
  let reconciled = 0;
  for (const closed of history.filter((p) => p?.status === "CLOSED" && p?.closeInfo && p?.positionHash)) {
    const existing = await db.prepare("SELECT position_hash FROM leverup_settlement_reconciliations WHERE position_hash = ?")
      .bind(closed.positionHash).first();
    if (existing) continue;
    const latest = await db.prepare("SELECT * FROM leverup_position_fee_snapshots WHERE position_hash = ? ORDER BY observed_at_ms DESC LIMIT 1")
      .bind(closed.positionHash).first();
    const entry = entries.find((x) => String(x.positionHash || "").toLowerCase() === String(closed.positionHash).toLowerCase());
    const lastSnapshot = latest ? {
      fundingFeeRaw: latest.funding_fee_raw, holdingFeeRaw: latest.holding_fee_raw,
    } : null;
    const settlement = reconcileClosedPosition(closed, lastSnapshot, entry?.plan?.preflight || null, {
      marginTokenDecimals: 18, marginTokenPriceUsd: null,
    });
    await persistSettlementReconciliation(db, settlement, {
      intentSignalId: entry?.signalId || null, source: "LeverUp closed-position history",
      estimatedProtocolCosts: entry?.plan?.preflight?.estimatedProtocolCosts || null,
    });
    if (entry?.signalId) await updateIntent(db, entry.signalId, "RECONCILED", {
      payload: { ...entry, settlement: serializable(settlement), reconciledAt: now },
    });
    reconciled++;
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
    .replace(/\\.(P|PERP)$/,"")
    .replace(/[-_/](USD|USDT|USDC|PERP)$/,"")
    .replace(/(USDT|USDC|USD|PERP)$/,"")
    .replace(/[^A-Z0-9]/g,"");
}

function pairMatchesPurgeSymbol(pair, symbol) {
  if (!symbol) return true;
  const values = [pair?.symbol, pair?.pairName, pair?.name, pair?.ticker, pair?.baseSymbol,
    pair?.pair?.symbol, pair?.pair?.name, pair?.baseToken?.symbol];
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
  const client = dependencies.publicClient || createLeverUpPublicClient(env?.LEVERUP_RPC_URL || "https://rpc.monad.xyz");
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
  if (String(env?.LEVERUP_LIVE_TRADING).toLowerCase() !== "true") {
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
  let submitted = 0;
  const results = [];
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
      const nonce = await (dependencies.readNonce || readLastAgentNonce)(traderAddress, agentAddress, { publicClient: client });
      const signalId = "manual-purge-" + position.positionHash.toLowerCase();
      const result = await submitLeverUpIntent({
        env, db, signalId, action: oneClickAction, actionValues, traderAddress, agentAddress,
        agentAuthorization: auth, nonce: (BigInt(nonce) + 1n).toString(), deadline: Math.floor(now / 1000) + 300,
        feeToken: fee.feeToken, antiDdosFee: fee.antiDdosFee,
        allowanceRequirements: fee.feeToken.toLowerCase() === ZERO.toLowerCase() ? [] : [{ tokenAddress: fee.feeToken, amount: fee.antiDdosFee }],
        pairBase: position.pairBase,
        payload: { positionHash: position.positionHash, action: "MANUAL_PURGE", requestedSymbol, symbol: position.purgeSymbol },
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
    results, readErrors,
  };
}

export async function runLeverUpPositionManager({ env, db, now = Date.now(), dependencies = {} }) {
  const reconciliation = await reconcilePendingLeverUpIntents({ env, db, now, dependencies });
  const traderAddress = String(env?.LEVERUP_TRADER_ADDRESS || "");
  const agentAddress = String(env?.LEVERUP_AGENT_ADDRESS || "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(traderAddress) || !/^0x[0-9a-fA-F]{40}$/.test(agentAddress)) {
    return { status: "BLOCKED_WALLET_CONFIGURATION", checked: 0, submitted: 0 };
  }
  const fetchImpl = dependencies.fetchImpl || fetch;
  const client = dependencies.publicClient || createLeverUpPublicClient(env?.LEVERUP_RPC_URL || "https://rpc.monad.xyz");
  let apiPositions = [];
  try { apiPositions = await (dependencies.fetchOpenPositions || fetchOpenPositions)(traderAddress, { fetchImpl }); }
  catch { /* on-chain discovery below remains authoritative when the indexer is unavailable */ }
  const entries = await readEntryMetadata(db);
  const pairBases = collectLeverUpPairBases(apiPositions, entries);
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
    if (!saved) continue; // Never apply CIEL exit policy to a manually opened or otherwise unmanaged position.
    const candidate = saved.candidate || {};
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
    const signalId = "position-" + hash + "-" + action.action.toLowerCase() + (action.levelIndex == null ? "" : "-" + action.levelIndex);
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
  const settlements = positionMap.size === 0
    ? await reconcileClosedSettlements({ env, db, now, dependencies }).catch((error) => ({ error: String(error?.message || error).slice(0, 200) }))
    : { skippedWhilePositionOpen: true };
  return { status: liveEnabled(env) ? "LIVE_MONITORING" : "READ_ONLY_MONITORING", checked: evaluated, submitted, snapshots, openPositionCount: positionMap.size, pairBasesChecked: pairBases.length, reconciliation, settlements };
}
