import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { ensureLeverUpTokenAllowance } from "../src/leverup-approval.js";
import { LEVERUP_1CT } from "../src/leverup-1ct.js";
import { LEVERUP_TOKENS } from "../src/leverup-readonly.js";

const traderKey = "0x" + "02".repeat(32);
const trader = privateKeyToAccount(traderKey).address;
const baseEnv = {
  LEVERUP_TRADER_PRIVATE_KEY: traderKey,
  LEVERUP_TRADER_ADDRESS: trader,
  LEVERUP_AUTO_APPROVE: "true",
  LEVERUP_LIVE_TRADING: "true",
  LEVERUP_KILL_SWITCH: "false",
};

let allowance = 0n;
let writes = [];
const publicClient = {
  readContract: async () => allowance,
  waitForTransactionReceipt: async ({ hash }) => ({ status: "success", transactionHash: hash }),
};
const walletClient = {
  account: { address: trader },
  writeContract: async (args) => {
    writes.push(args);
    allowance = args.args[1];
    return "0x" + String(writes.length).padStart(64, "0");
  },
};

const approved = await ensureLeverUpTokenAllowance({
  env: baseEnv, tokenAddress: LEVERUP_TOKENS.WMON, requiredAmount: 123n,
  publicClient, walletClient,
});
assert.equal(approved.status, "APPROVED");
assert.equal(approved.spender, LEVERUP_1CT.diamond);
assert.equal(approved.allowance, "123");
assert.equal(writes.length, 1);
assert.equal(writes[0].args[1], 123n);

// LVMON must use the same exact-amount auto-approval path as WMON.
writes = [];
allowance = 0n;
const lvmonApproved = await ensureLeverUpTokenAllowance({
  env: baseEnv, tokenAddress: LEVERUP_TOKENS.LVMON, requiredAmount: 456n,
  publicClient, walletClient,
});
assert.equal(lvmonApproved.status, "APPROVED");
assert.equal(lvmonApproved.tokenAddress, LEVERUP_TOKENS.LVMON);
assert.equal(lvmonApproved.spender, LEVERUP_1CT.diamond);
assert.equal(lvmonApproved.allowance, "456");
assert.equal(writes.length, 1);
assert.equal(writes[0].address, LEVERUP_TOKENS.LVMON);
assert.equal(writes[0].args[0], LEVERUP_1CT.diamond);
assert.equal(writes[0].args[1], 456n);


writes = [];
const sufficient = await ensureLeverUpTokenAllowance({
  env: baseEnv, tokenAddress: LEVERUP_TOKENS.WMON, requiredAmount: 100n,
  publicClient, walletClient,
});
assert.equal(sufficient.status, "ALREADY_SUFFICIENT");
assert.equal(writes.length, 0);

allowance = 10n;
writes = [];
const resetThenApprove = await ensureLeverUpTokenAllowance({
  env: baseEnv, tokenAddress: LEVERUP_TOKENS.WMON, requiredAmount: 50n,
  publicClient, walletClient,
});
assert.equal(resetThenApprove.status, "APPROVED");
assert.deepEqual(writes.map((write) => write.args[1]), [0n, 50n]);

await assert.rejects(() => ensureLeverUpTokenAllowance({
  env: { ...baseEnv, LEVERUP_LIVE_TRADING: "false" },
  tokenAddress: LEVERUP_TOKENS.WMON, requiredAmount: 1n, publicClient, walletClient,
}), /AUTO_APPROVAL_REQUIRES_EXPLICIT_LIVE_MODE/);
await assert.rejects(() => ensureLeverUpTokenAllowance({
  env: { ...baseEnv, LEVERUP_KILL_SWITCH: "true" },
  tokenAddress: LEVERUP_TOKENS.WMON, requiredAmount: 1n, publicClient, walletClient,
}), /AUTO_APPROVAL_REQUIRES_EXPLICIT_LIVE_MODE/);
await assert.rejects(() => ensureLeverUpTokenAllowance({
  env: { ...baseEnv, LEVERUP_TRADER_ADDRESS: "0x3333333333333333333333333333333333333333" },
  tokenAddress: LEVERUP_TOKENS.WMON, requiredAmount: 1n, publicClient, walletClient,
}), /TRADER_SIGNER_KEY_DOES_NOT_MATCH/);
await assert.rejects(() => ensureLeverUpTokenAllowance({
  env: baseEnv, tokenAddress: "0x3333333333333333333333333333333333333333",
  requiredAmount: 1n, publicClient, walletClient,
}), /TOKEN_NOT_ALLOWLISTED/);
console.log("PASS: exact allowance, no-op when sufficient, zero-reset compatibility, signer identity, token allowlist and live/kill-switch gates.");


// Primary RPC can remain stale after the receipt. The secondary reader confirms the
// exact allowance without sending a duplicate approval transaction.
let primaryReadCount = 0;
let secondaryReadCount = 0;
let secondaryWrites = [];
const stalePrimary = {
  readContract: async () => { primaryReadCount++; return 0n; },
  waitForTransactionReceipt: async ({ hash }) => ({ status: "success", transactionHash: hash, blockNumber: 987n }),
};
const secondaryReader = {
  getChainId: async () => 143,
  readContract: async () => { secondaryReadCount++; return 789n; },
};
const staleWallet = {
  account: { address: trader },
  writeContract: async (args) => { secondaryWrites.push(args); return "0x" + "ab".repeat(32); },
};
const recovered = await ensureLeverUpTokenAllowance({
  env: { ...baseEnv, ALCHEMY_RPC: "https://alchemy.example/rpc" },
  tokenAddress: LEVERUP_TOKENS.WMON, requiredAmount: 789n,
  publicClient: stalePrimary, walletClient: staleWallet,
  secondaryPublicClient: secondaryReader,
});
assert.equal(recovered.status, "APPROVED");
assert.equal(recovered.allowance, "789");
assert.equal(primaryReadCount, 4);
assert.equal(secondaryReadCount, 1);
assert.equal(secondaryWrites.length, 1, "only the single exact approval may be broadcast");
assert.equal(recovered.allowanceReadDiagnostics.secondaryObservation, "allowance:789");

const wrongChainSecondary = { getChainId: async () => 1, readContract: async () => 999n };
await assert.rejects(() => ensureLeverUpTokenAllowance({
  env: baseEnv, tokenAddress: LEVERUP_TOKENS.WMON, requiredAmount: 1000n,
  publicClient: stalePrimary, walletClient: staleWallet,
  secondaryPublicClient: wrongChainSecondary,
}), /secondary=wrong_chain:1/);
