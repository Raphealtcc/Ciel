import {
  encodeAbiParameters,
  parseAbiParameter,
  keccak256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const LEVERUP_1CT = Object.freeze({
  baseUrl: "https://oneclick-01-keeper.leverup.xyz",
  chainId: 143,
  diamond: "0xea1b8E4aB7f14F7dCA68c5B214303B13078FC5ec",
  zeroAddress: "0x0000000000000000000000000000000000000000",
});

export const OneClickAction = Object.freeze({
  MARKET_OPEN: 0,
  MARKET_CLOSE: 1,
  LIMIT_OPEN: 2,
  LIMIT_CANCEL: 3,
  LIMIT_UPDATE_TP_SL: 4,
  ADD_MARGIN: 5,
  REMOVE_MARGIN: 6,
  UPDATE_TP_SL: 7,
  BATCH_MARKET_CLOSE: 8,
  PARTIAL_CLOSE: 9,
  CANCEL_DECREASE_ORDER: 10,
  BATCH_CREATE_DECREASE_ORDERS: 11,
  BATCH_UPDATE_DECREASE_ORDERS: 12,
  CANCEL_ALL_DECREASE_ORDERS: 13,
});

const ACTION_TYPE_NAMES = Object.freeze({
  0: "OneClickMarketOpen",
  1: "OneClickMarketClose",
  2: "OneClickLimitOpen",
  3: "OneClickLimitCancel",
  4: "OneClickLimitUpdateTpSl",
  5: "OneClickAddMargin",
  6: "OneClickRemoveMargin",
  7: "OneClickUpdateTpSl",
  8: "OneClickBatchMarketClose",
  9: "OneClickPartialClose",
  10: "OneClickCancelDecreaseOrder",
  11: "OneClickBatchCreateDecreaseOrders",
  12: "OneClickBatchUpdateDecreaseOrders",
  13: "OneClickCancelAllDecreaseOrders",
});

const ACTION_DATA_ABI_TYPES = Object.freeze({
  0: ["address", "bool", "address", "address", "uint96", "uint128", "uint128", "uint128", "uint128", "uint24", "uint96"],
  1: ["bytes32", "uint24"],
  2: ["address", "bool", "address", "address", "uint96", "uint128", "uint128", "uint128", "uint128", "uint24", "uint96"],
  3: ["bytes32"],
  4: ["bytes32", "uint128", "uint128"],
  5: ["bytes32", "address", "uint96"],
  6: ["bytes32", "uint96"],
  7: ["bytes32", "uint128", "uint128"],
  8: ["bytes32[]", "uint24"],
  9: ["bytes32", "uint128", "uint24"],
  10: ["bytes32"],
  11: ["bytes32", "(uint8,uint128,uint128,uint24)[]"],
  12: ["(bytes32,uint128,uint128,uint24)[]"],
  13: ["bytes32"],
});

const COMMON_EIP712_FIELDS = Object.freeze([
  { name: "trader", type: "address" },
  { name: "action", type: "uint8" },
  { name: "nonce", type: "uint64" },
  { name: "deadline", type: "uint48" },
  { name: "feeToken", type: "address" },
  { name: "antiDdosFee", type: "uint96" },
  { name: "actionDataHash", type: "bytes32" },
]);

function stripTraderWord(encoded) {
  return `0x${encoded.slice(2 + 64)}`;
}

export function buildActionData(action, trader, values) {
  if (!Number.isInteger(action) || !ACTION_TYPE_NAMES[action]) {
    throw new Error(`Unknown LeverUp 1CT action: ${action}`);
  }
  if (!Array.isArray(values)) throw new Error("action values must be an array");

  let encoded;
  if (action === OneClickAction.BATCH_CREATE_DECREASE_ORDERS) {
    encoded = encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }, parseAbiParameter("(uint8,uint128,uint128,uint24)[]")],
      [trader, values[0], values[1]],
    );
  } else if (action === OneClickAction.BATCH_UPDATE_DECREASE_ORDERS) {
    encoded = encodeAbiParameters(
      [{ type: "address" }, parseAbiParameter("(bytes32,uint128,uint128,uint24)[]")],
      [trader, values[0]],
    );
  } else {
    const types = ACTION_DATA_ABI_TYPES[action];
    encoded = encodeAbiParameters(
      [{ type: "address" }, ...types.map((type) => ({ type }))],
      [trader, ...values],
    );
  }
  return stripTraderWord(encoded);
}

export function buildTypedIntent({
  action, trader, nonce, deadline, feeToken = LEVERUP_1CT.zeroAddress,
  antiDdosFee = 0n, actionValues,
}) {
  const typeName = ACTION_TYPE_NAMES[action];
  if (!typeName) throw new Error(`Unknown LeverUp 1CT action: ${action}`);
  const nonceValue = BigInt(nonce);
  const deadlineValue = BigInt(deadline);
  const feeValue = BigInt(antiDdosFee);
  if (nonceValue <= 0n || deadlineValue <= BigInt(Math.floor(Date.now() / 1000))) {
    throw new Error("nonce and deadline must be positive and deadline must be in the future");
  }
  if (feeValue < 0n) throw new Error("antiDdosFee cannot be negative");

  const actionData = buildActionData(action, trader, actionValues);
  const actionDataHash = keccak256(actionData);
  const typedData = {
    domain: {
      name: "LeverupOneClickV2",
      version: "1",
      chainId: LEVERUP_1CT.chainId,
      verifyingContract: LEVERUP_1CT.diamond,
    },
    types: { [typeName]: COMMON_EIP712_FIELDS },
    primaryType: typeName,
    message: {
      trader,
      action,
      nonce: nonceValue,
      deadline: Number(deadlineValue),
      feeToken,
      antiDdosFee: feeValue,
      actionDataHash,
    },
  };
  return {
    trader, action, nonce: nonceValue.toString(), deadline: Number(deadlineValue),
    feeToken, antiDdosFee: feeValue.toString(), actionData, actionDataHash, typedData,
  };
}

export function selectFeeToken(action, feeConfig, accountStateByToken, additionalSpends = [], { requireAllowance = true } = {}) {
  const options = (Array.isArray(feeConfig) ? feeConfig : [])
    .filter((item) => Number(item.action) === action && item.enabled === true)
    .sort((a, b) => Number(a.priority) - Number(b.priority));

  if (!options.length) {
    return { feeToken: LEVERUP_1CT.zeroAddress, antiDdosFee: 0n };
  }

  for (const option of options) {
    const token = String(option.feeToken);
    const state = accountStateByToken?.[token.toLowerCase()];
    if (!state) continue;
    const extra = additionalSpends
      .filter((spend) => spend.token.toLowerCase() === token.toLowerCase())
      .reduce((sum, spend) => sum + BigInt(spend.amount), 0n);
    const fee = BigInt(option.antiDdosFee);
    const required = fee + extra;
    if (BigInt(state.balance) >= required && (!requireAllowance || BigInt(state.allowance) >= required)) {
      return { feeToken: token, antiDdosFee: fee };
    }
  }
  throw new Error("No enabled execution-fee token has sufficient balance and Diamond allowance");
}

export function assertLiveExecutionAllowed({
  enabled, killSwitchActive, agentAuthorization, agentAddress, traderAddress,
  signerPrivateKey, action, preflight, now = Date.now(), maxPreflightAgeMs = 30_000,
}) {
  if (enabled !== true) throw new Error("LIVE_EXECUTION_DISABLED");
  if (killSwitchActive === true) throw new Error("LIVE_EXECUTION_KILL_SWITCH_ACTIVE");
  if (!/^0x[0-9a-fA-F]{40}$/.test(traderAddress || "")) throw new Error("LEVERUP_TRADER_ADDRESS_MISSING_OR_INVALID");
  if (!/^0x[0-9a-fA-F]{40}$/.test(agentAddress || "")) throw new Error("LEVERUP_AGENT_ADDRESS_MISSING_OR_INVALID");
  if (!signerPrivateKey) throw new Error("LEVERUP_AGENT_SIGNING_KEY_MISSING");
  if (!agentAuthorization?.authorized ||
      String(agentAuthorization.agentAddress).toLowerCase() !== agentAddress.toLowerCase()) {
    throw new Error("LEVERUP_AGENT_NOT_VERIFIED_AUTHORIZED");
  }
  const permissionByAction = { 0: "canMarketOpen", 1: "canMarketClose", 9: "canPartialClose" };
  const requiredPermission = permissionByAction[Number(action)];
  if (!requiredPermission) throw new Error("LEVERUP_ACTION_NOT_ALLOWED_BY_CIEL");
  if (agentAuthorization[requiredPermission] !== true) throw new Error("LEVERUP_AGENT_ACTION_PERMISSION_MISSING");
  // Exits remain available even if entry data is stale. Only new market opens
  // require a fresh, passing 50x+ preflight.
  if (Number(action) === 0) {
    if (!preflight || preflight.preflightPassed !== true) throw new Error("LEVERUP_PREFLIGHT_NOT_PASSED");
    if (Number(preflight.requestedLeverage) < 50 || Number(preflight.marketMaxLeverage) < 50 ||
        Number(preflight.maxLeverageForNotional) < 50) {
      throw new Error("LEVERUP_MINIMUM_50X_NOT_MET");
    }
    if (!preflight.pairBase || preflight.status !== "AVAILABLE") throw new Error("LEVERUP_PREFLIGHT_MARKET_INVALID");
    const checkedAt = Number(preflight.checkedAt);
    if (!Number.isFinite(checkedAt) || checkedAt > now + 5_000 || now - checkedAt > maxPreflightAgeMs) {
      throw new Error("LEVERUP_PREFLIGHT_STALE");
    }
  }
}

// Signs an intent locally for validation only. This function never calls LeverUp or broadcasts.
export async function signIntentDryRun({
  env, traderAddress, agentAddress, agentAuthorization, action, nonce, deadline,
  actionValues, feeToken = LEVERUP_1CT.zeroAddress, antiDdosFee = 0n,
  preflight, now = Date.now(), maxPreflightAgeMs = 30_000,
}) {
  if (String(env?.LEVERUP_LIVE_TRADING).toLowerCase() !== "false" ||
      String(env?.LEVERUP_KILL_SWITCH).toLowerCase() !== "true") throw new Error("DRY_RUN_REQUIRES_LIVE_OFF_AND_KILL_SWITCH_ON");
  if (!/^0x[0-9a-fA-F]{40}$/.test(traderAddress || "")) throw new Error("LEVERUP_TRADER_ADDRESS_MISSING_OR_INVALID");
  if (!/^0x[0-9a-fA-F]{40}$/.test(agentAddress || "")) throw new Error("LEVERUP_AGENT_ADDRESS_MISSING_OR_INVALID");
  if (!agentAuthorization?.authorized || String(agentAuthorization.agentAddress).toLowerCase() !== agentAddress.toLowerCase()) throw new Error("LEVERUP_AGENT_NOT_VERIFIED_AUTHORIZED");
  const permissionByAction = { 0: "canMarketOpen", 1: "canMarketClose", 9: "canPartialClose" };
  const permission = permissionByAction[Number(action)];
  if (!permission || agentAuthorization[permission] !== true) throw new Error("LEVERUP_AGENT_ACTION_PERMISSION_MISSING");
  if (Number(action) === 0) {
    if (!preflight || preflight.preflightPassed !== true || preflight.status !== "AVAILABLE") throw new Error("LEVERUP_PREFLIGHT_NOT_PASSED");
    if (Number(preflight.requestedLeverage) < 50 || Number(preflight.marketMaxLeverage) < 50 || Number(preflight.maxLeverageForNotional) < 50) throw new Error("LEVERUP_MINIMUM_50X_NOT_MET");
    const checkedAt = Number(preflight.checkedAt);
    if (!Number.isFinite(checkedAt) || checkedAt > now + 5_000 || now - checkedAt > maxPreflightAgeMs) throw new Error("LEVERUP_PREFLIGHT_STALE");
  }
  const key = String(env?.LEVERUP_AGENT_PRIVATE_KEY || "").trim();
  if (!key) throw new Error("LEVERUP_AGENT_SIGNING_KEY_MISSING");
  const signer = privateKeyToAccount(key.startsWith("0x") ? key : "0x" + key);
  if (signer.address.toLowerCase() !== agentAddress.toLowerCase()) throw new Error("LEVERUP_SIGNER_KEY_DOES_NOT_MATCH_AUTHORIZED_AGENT");
  const intent = buildTypedIntent({ action, trader: traderAddress, nonce, deadline, actionValues, feeToken, antiDdosFee });
  const signature = await signer.signTypedData(intent.typedData);
  return { signed: true, signerAddress: signer.address, signatureDigest: keccak256(signature), intentDigest: intent.actionDataHash };
}

export async function signAndSubmitIntent(options) {
  // This guard is deliberately the first operation: no signer construction,
  // signature generation, or network request is possible while execution is OFF.
  assertLiveExecutionAllowed(options);

  const {
    traderAddress, signerPrivateKey, action, nonce, deadline, actionValues,
    feeToken = LEVERUP_1CT.zeroAddress, antiDdosFee = 0n,
    fetchImpl = fetch, baseUrl = LEVERUP_1CT.baseUrl,
  } = options;

  const intent = buildTypedIntent({
    action, trader: traderAddress, nonce, deadline, actionValues, feeToken, antiDdosFee,
  });
  const signer = privateKeyToAccount(signerPrivateKey);
  if (signer.address.toLowerCase() !== options.agentAddress.toLowerCase()) {
    throw new Error("LEVERUP_SIGNER_KEY_DOES_NOT_MATCH_AUTHORIZED_AGENT");
  }
  const signature = await signer.signTypedData(intent.typedData);
  const response = await fetchImpl(`${baseUrl}/v2/trading/submit-intent?blockchain=MONAD`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      trader: intent.trader,
      action: intent.action,
      nonce: intent.nonce,
      deadline: intent.deadline,
      feeToken: intent.feeToken,
      antiDdosFee: intent.antiDdosFee,
      actionData: intent.actionData,
      signature,
    }),
  });
  if (!response.ok) {
    throw new Error(`LeverUp submit-intent HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const intentHash = (await response.text()).replace(/^"|"$/g, "");
  if (!/^0x[0-9a-fA-F]{64}$/.test(intentHash)) {
    throw new Error("LeverUp returned an invalid intent hash");
  }
  return { intentHash, intent };
}

export async function getIntentStatusOnce(baseUrl, intentHash, { fetchImpl = fetch } = {}) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(intentHash || ""))) throw new Error("Invalid intent hash");
  const response = await fetchImpl(`${baseUrl || LEVERUP_1CT.baseUrl}/v2/trading/${intentHash}/status`);
  if (response.status === 404) return { indexed: false, executed: false, skipped: false, status: "NOT_INDEXED" };
  if (!response.ok) throw new Error(`LeverUp intent status HTTP ${response.status}`);
  const status = await response.json();
  return { ...status, indexed: true };
}

export async function pollIntentStatus(baseUrl, intentHash, {
  intervalMs = 300, timeoutMs = 300_000, fetchImpl = fetch,
} = {}) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(intentHash)) throw new Error("Invalid intent hash");
  const stopAt = Date.now() + timeoutMs;
  while (Date.now() < stopAt) {
    const response = await fetchImpl(`${baseUrl || LEVERUP_1CT.baseUrl}/v2/trading/${intentHash}/status`);
    if (response.ok) {
      const status = await response.json();
      if (status.executed || status.skipped) return status;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for LeverUp intent status");
}
