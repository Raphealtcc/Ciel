import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import {
  LEVERUP_1CT,
  OneClickAction,
  buildActionData,
  buildTypedIntent,
  selectFeeToken,
  signAndSubmitIntent,
  signIntentDryRun,
} from "../src/leverup-1ct.js";

const trader = "0x1111111111111111111111111111111111111111";
const pairBase = "0x2222222222222222222222222222222222222222";
const tokenIn = "0x3333333333333333333333333333333333333333";
const lvToken = "0x4444444444444444444444444444444444444444";
const hash = `0x${"ab".repeat(32)}`;
const offset40 = "0000000000000000000000000000000000000000000000000000000000000040";
const offset60 = "0000000000000000000000000000000000000000000000000000000000000060";

const openData = buildActionData(OneClickAction.MARKET_OPEN, trader, [
  pairBase, true, tokenIn, lvToken, 11n * 10n ** 18n, 10000000000n,
  2n * 10n ** 18n, 0n, 0n, 0, 0n,
]);
assert.equal(openData.length, 2 + 11 * 64, "market-open actionData must contain exactly eleven ABI words after trader is stripped");
assert.equal(openData.slice(2 + 24, 2 + 64), pairBase.slice(2).toLowerCase(),
  "stripped actionData must begin with the correctly padded pairBase word");

const closeData = buildActionData(OneClickAction.MARKET_CLOSE, trader, [hash, 0]);
assert.equal(closeData.length, 2 + 2 * 64);

const dynamicClose = buildActionData(OneClickAction.BATCH_MARKET_CLOSE, trader, [[hash], 0]);
assert.equal(dynamicClose.slice(2, 66), offset60,
  "batch-close dynamic offset must include the prepended trader word");

const tpData = buildActionData(OneClickAction.BATCH_CREATE_DECREASE_ORDERS, trader, [
  hash,
  [[0, 2n * 10n ** 18n, 5000000000n, 0], [1, 1n * 10n ** 18n, 10000000000n, 0]],
]);
assert.equal(tpData.slice(2, 66), hash.slice(2), "batch TP/SL data must begin with the position hash");
assert.equal(tpData.slice(2 + 64, 2 + 128), offset60,
  "batch TP/SL array offset must include the prepended trader word");

const updateData = buildActionData(OneClickAction.BATCH_UPDATE_DECREASE_ORDERS, trader, [
  [[hash, 2n * 10n ** 18n, 5000000000n, 0]],
]);
assert.equal(updateData.slice(2, 66), offset40,
  "batch-update array offset must include the prepended trader word");

const intent = buildTypedIntent({
  action: OneClickAction.MARKET_CLOSE,
  trader,
  nonce: "1785312000123",
  deadline: Math.floor(Date.now() / 1000) + 300,
  actionValues: [hash, 0],
});
assert.equal(intent.typedData.domain.chainId, 143);
assert.equal(intent.typedData.domain.verifyingContract, LEVERUP_1CT.diamond);
assert.equal(intent.typedData.primaryType, "OneClickMarketClose");
assert.equal(intent.nonce, "1785312000123");
assert.equal(intent.actionDataHash.length, 66);

const fees = [
  { action: 0, feeToken: tokenIn, antiDdosFee: "500", enabled: true, priority: 0 },
];
assert.deepEqual(selectFeeToken(0, fees, {
  [tokenIn.toLowerCase()]: { balance: 1000n, allowance: 1000n },
}, [{ token: tokenIn, amount: 500n }]), { feeToken: tokenIn, antiDdosFee: 500n });
assert.throws(() => selectFeeToken(0, fees, {
  [tokenIn.toLowerCase()]: { balance: 999n, allowance: 1000n },
}, [{ token: tokenIn, amount: 500n }]), /No enabled execution-fee token/);

let networkTouched = false;
await assert.rejects(() => signAndSubmitIntent({
  enabled: false,
  killSwitchActive: false,
  agentAuthorization: { authorized: true, agentAddress: "0x5555555555555555555555555555555555555555", canMarketOpen: true, canMarketClose: true, canPartialClose: true },
  agentAddress: "0x5555555555555555555555555555555555555555",
  traderAddress: trader,
  signerPrivateKey: `0x${"01".repeat(32)}`,
  action: OneClickAction.MARKET_CLOSE,
  nonce: "1785312000123",
  deadline: Math.floor(Date.now() / 1000) + 300,
  actionValues: [hash, 0],
  fetchImpl: async () => { networkTouched = true; throw new Error("must not be called"); },
}), /LIVE_EXECUTION_DISABLED/);
assert.equal(networkTouched, false, "disabled live mode must never call LeverUp");

await assert.rejects(() => signAndSubmitIntent({
  enabled: true,
  killSwitchActive: true,
  agentAuthorized: true,
  traderAddress: trader,
  signerPrivateKey: `0x${"01".repeat(32)}`,
  action: OneClickAction.MARKET_CLOSE,
  nonce: "1785312000123",
  deadline: Math.floor(Date.now() / 1000) + 300,
  actionValues: [hash, 0],
  fetchImpl: async () => { networkTouched = true; throw new Error("must not be called"); },
}), /LIVE_EXECUTION_KILL_SWITCH_ACTIVE/);
assert.equal(networkTouched, false, "kill switch must prevent submission");

await assert.rejects(() => signAndSubmitIntent({
  enabled: true,
  killSwitchActive: false,
  agentAuthorization: { authorized: true, agentAddress: "0x5555555555555555555555555555555555555555", canMarketOpen: true, canMarketClose: true, canPartialClose: true },
  agentAddress: "0x5555555555555555555555555555555555555555",
  traderAddress: trader,
  signerPrivateKey: `0x${"01".repeat(32)}`,
  action: OneClickAction.MARKET_OPEN,
  nonce: "1785312000123",
  deadline: Math.floor(Date.now() / 1000) + 300,
  actionValues: [pairBase, true, tokenIn, lvToken, 11n * 10n ** 18n, 10000000000n, 2n * 10n ** 18n, 0n, 0n, 0, 0n],
  preflight: { preflightPassed: true, requestedLeverage: 25, marketMaxLeverage: 100, maxLeverageForNotional: 100, pairBase, status: "AVAILABLE", checkedAt: Date.now() },
  fetchImpl: async () => { networkTouched = true; throw new Error("must not be called"); },
}), /LEVERUP_MINIMUM_50X_NOT_MET/);
assert.equal(networkTouched, false, "50x floor must block before signing or network access");

await assert.rejects(() => signAndSubmitIntent({
  enabled: true,
  killSwitchActive: false,
  agentAuthorization: { authorized: true, agentAddress: "0x5555555555555555555555555555555555555555", canMarketOpen: true, canMarketClose: true, canPartialClose: true },
  agentAddress: "0x5555555555555555555555555555555555555555",
  traderAddress: trader,
  signerPrivateKey: `0x${"01".repeat(32)}`,
  action: OneClickAction.MARKET_OPEN,
  nonce: "1785312000123",
  deadline: Math.floor(Date.now() / 1000) + 300,
  actionValues: [pairBase, true, tokenIn, lvToken, 11n * 10n ** 18n, 10000000000n, 2n * 10n ** 18n, 0n, 0n, 0, 0n],
  preflight: { preflightPassed: true, requestedLeverage: 50, marketMaxLeverage: 100, maxLeverageForNotional: 50, pairBase, status: "AVAILABLE", checkedAt: Date.now() - 31_000 },
  fetchImpl: async () => { networkTouched = true; throw new Error("must not be called"); },
}), /LEVERUP_PREFLIGHT_STALE/);
assert.equal(networkTouched, false, "stale preflight must block before signing or network access");

await assert.rejects(() => signAndSubmitIntent({
  enabled: true, killSwitchActive: false,
  agentAuthorization: { authorized: true, agentAddress: "0x5555555555555555555555555555555555555555", canMarketOpen: false, canMarketClose: true, canPartialClose: true },
  agentAddress: "0x5555555555555555555555555555555555555555",
  traderAddress: trader, signerPrivateKey: `0x${"01".repeat(32)}`,
  action: OneClickAction.MARKET_OPEN, nonce: "1785312000123",
  deadline: Math.floor(Date.now() / 1000) + 300,
  actionValues: [pairBase, true, tokenIn, lvToken, 11n * 10n ** 18n, 10000000000n, 2n * 10n ** 18n, 0n, 0n, 0, 0n],
  preflight: { preflightPassed: true, requestedLeverage: 50, marketMaxLeverage: 100, maxLeverageForNotional: 50, pairBase, status: "AVAILABLE", checkedAt: Date.now() },
  fetchImpl: async () => { networkTouched = true; throw new Error("must not be called"); },
}), /AGENT_ACTION_PERMISSION_MISSING/);
assert.equal(networkTouched, false, "missing open permission must block before network access");

const dryKey = `0x${"01".repeat(32)}`;
const dryAgent = privateKeyToAccount(dryKey).address;
const dryRun = await signIntentDryRun({
  env: { LEVERUP_AGENT_PRIVATE_KEY: dryKey, LEVERUP_LIVE_TRADING: "false", LEVERUP_KILL_SWITCH: "true" },
  traderAddress: trader, agentAddress: dryAgent,
  agentAuthorization: { authorized: true, agentAddress: dryAgent, canMarketOpen: true },
  action: OneClickAction.MARKET_OPEN, nonce: "1785312000124",
  deadline: Math.floor(Date.now() / 1000) + 300,
  actionValues: [pairBase, true, tokenIn, lvToken, 11n * 10n ** 18n, 10000000000n, 2n * 10n ** 18n, 0n, 0n, 0, 0n],
  preflight: { preflightPassed: true, requestedLeverage: 50, marketMaxLeverage: 100, maxLeverageForNotional: 50, pairBase, status: "AVAILABLE", checkedAt: Date.now() },
});
assert.equal(dryRun.signed, true);
assert.equal(dryRun.signerAddress.toLowerCase(), dryAgent.toLowerCase());
assert.match(dryRun.signatureDigest, /^0x[0-9a-f]{64}$/);
await assert.rejects(() => signIntentDryRun({
  env: { LEVERUP_AGENT_PRIVATE_KEY: dryKey, LEVERUP_LIVE_TRADING: "false", LEVERUP_KILL_SWITCH: "true" },
  traderAddress: trader, agentAddress: "0x5555555555555555555555555555555555555555",
  agentAuthorization: { authorized: true, agentAddress: "0x5555555555555555555555555555555555555555", canMarketOpen: true },
  action: OneClickAction.MARKET_OPEN, nonce: "1785312000125",
  deadline: Math.floor(Date.now() / 1000) + 300,
  actionValues: [pairBase, true, tokenIn, lvToken, 11n * 10n ** 18n, 10000000000n, 2n * 10n ** 18n, 0n, 0n, 0, 0n],
  preflight: { preflightPassed: true, requestedLeverage: 50, marketMaxLeverage: 100, maxLeverageForNotional: 50, pairBase, status: "AVAILABLE", checkedAt: Date.now() },
}), /LEVERUP_SIGNER_KEY_DOES_NOT_MATCH_AUTHORIZED_AGENT/);

const submitKey = "0x" + "01".repeat(32);
const submitAgent = privateKeyToAccount(submitKey).address;
let capturedRequest = null;
const submittedIntent = await signAndSubmitIntent({
  enabled: true, killSwitchActive: false,
  agentAuthorization: { authorized: true, agentAddress: submitAgent, canMarketOpen: true },
  agentAddress: submitAgent, traderAddress: trader, signerPrivateKey: submitKey,
  action: OneClickAction.MARKET_OPEN, nonce: "1785312000126",
  deadline: Math.floor(Date.now() / 1000) + 300,
  actionValues: [pairBase, true, tokenIn, lvToken, 11n * 10n ** 18n,
    10000000000n, 2n * 10n ** 18n, 0n, 0n, 0, 0n],
  preflight: { preflightPassed: true, requestedLeverage: 50, marketMaxLeverage: 100,
    maxLeverageForNotional: 50, pairBase, status: "AVAILABLE", checkedAt: Date.now() },
  fetchImpl: async (url, options) => {
    capturedRequest = { url, options };
    return { ok: true, text: async () => JSON.stringify({ intentHash: hash }) };
  },
});
assert.equal(submittedIntent.intentHash, hash,
  "1CT submit must accept the documented intentHash response when returned in a JSON object");
assert.equal(capturedRequest.url, LEVERUP_1CT.baseUrl + "/v2/trading/submit-intent?blockchain=MONAD");
assert.equal(JSON.parse(capturedRequest.options.body).trader, trader);
assert.equal(JSON.parse(capturedRequest.options.body).action, OneClickAction.MARKET_OPEN);
assert.match(JSON.parse(capturedRequest.options.body).signature, /^0x[0-9a-f]+$/);

console.log("PASS: 1CT ABI encoding, dynamic offsets, EIP-712, fee-token selection, hard-off, kill-switch, fresh preflight and 50x execution floor and local-only signer address verification.");
