import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  isAddress,
  maxUint256,
  formatUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { LEVERUP_1CT } from "./leverup-1ct.js";
import { LEVERUP_TOKENS } from "./leverup-readonly.js";

const MONAD = defineChain({
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc2.monad.xyz"] } },
});

const ERC20_APPROVAL_ABI = [
  { type: "function", name: "allowance", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }] },
];

const APPROVABLE_TOKENS = new Set([
  LEVERUP_TOKENS.WMON,
  LEVERUP_TOKENS.LVMON,
  LEVERUP_TOKENS.USDC,
  LEVERUP_TOKENS.LVUSD,
].map((address) => address.toLowerCase()));

function normalizedKey(value) {
  const key = String(value || "").trim();
  if (!key) throw new Error("LEVERUP_TRADER_SIGNING_KEY_MISSING");
  return key.startsWith("0x") ? key : "0x" + key;
}

export function inspectLeverUpTraderSigner({ env }) {
  const traderAddress = String(env?.LEVERUP_TRADER_ADDRESS || "");
  if (!isAddress(traderAddress)) return { status: "FAILED", reason: "LEVERUP_TRADER_ADDRESS_MISSING_OR_INVALID" };
  try {
    const account = privateKeyToAccount(normalizedKey(env?.LEVERUP_TRADER_PRIVATE_KEY));
    const matches = account.address.toLowerCase() === traderAddress.toLowerCase();
    return { status: matches ? "PASS" : "FAILED", signerAddress: account.address,
      matchesConfiguredTrader: matches, reason: matches ? null : "LEVERUP_TRADER_SIGNER_KEY_DOES_NOT_MATCH_TRADER_ADDRESS" };
  } catch (error) {
    return { status: "FAILED", reason: String(error?.message || error).slice(0, 180) };
  }
}

/**
 * Ensure a precise ERC-20 allowance for the fixed LeverUp Monad 1CT Diamond.
 * This is intentionally unavailable in dry-run mode. The caller must invoke it
 * immediately before execution, with live mode explicitly enabled and the
 * kill switch explicitly disabled.
 */
export async function ensureLeverUpTokenAllowance({
  env,
  tokenAddress,
  requiredAmount,
  publicClient,
  walletClient,
}) {
  if (String(env?.LEVERUP_AUTO_APPROVE).toLowerCase() !== "true") {
    throw new Error("LEVERUP_AUTO_APPROVE_DISABLED");
  }
  if (String(env?.LEVERUP_LIVE_TRADING).toLowerCase() !== "true" ||
      String(env?.LEVERUP_KILL_SWITCH).toLowerCase() !== "false") {
    throw new Error("AUTO_APPROVAL_REQUIRES_EXPLICIT_LIVE_MODE_AND_KILL_SWITCH_OFF");
  }

  const traderAddress = String(env?.LEVERUP_TRADER_ADDRESS || "");
  if (!isAddress(traderAddress)) throw new Error("LEVERUP_TRADER_ADDRESS_MISSING_OR_INVALID");
  if (!isAddress(tokenAddress) || !APPROVABLE_TOKENS.has(tokenAddress.toLowerCase())) {
    throw new Error("LEVERUP_APPROVAL_TOKEN_NOT_ALLOWLISTED");
  }

  const amount = BigInt(requiredAmount);
  if (amount <= 0n || amount === maxUint256) {
    throw new Error("LEVERUP_APPROVAL_AMOUNT_MUST_BE_PRECISE_AND_POSITIVE");
  }

  const account = privateKeyToAccount(normalizedKey(env?.LEVERUP_TRADER_PRIVATE_KEY));
  if (account.address.toLowerCase() !== traderAddress.toLowerCase()) {
    throw new Error("LEVERUP_TRADER_SIGNER_KEY_DOES_NOT_MATCH_TRADER_ADDRESS");
  }

  const rpcUrl = String(env?.LEVERUP_RPC_URL || "https://rpc2.monad.xyz");
  const reader = publicClient || createPublicClient({ chain: MONAD, transport: http(rpcUrl) });
  const signer = walletClient || createWalletClient({
    account, chain: MONAD, transport: http(rpcUrl),
  });
  if (signer.account?.address?.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error("LEVERUP_TRADER_WALLET_CLIENT_MISMATCH");
  }

  const spender = LEVERUP_1CT.diamond;
  const readAllowance = () => reader.readContract({
    address: tokenAddress, abi: ERC20_APPROVAL_ABI, functionName: "allowance",
    args: [traderAddress, spender],
  });
  const currentAllowance = await readAllowance();
  if (currentAllowance >= amount) {
    return { status: "ALREADY_SUFFICIENT", traderAddress, tokenAddress, spender,
      allowance: currentAllowance.toString(), requiredAmount: amount.toString(), approvalTxHash: null };
  }

  // Some ERC-20 implementations require allowance to be reset before increasing it.
  if (currentAllowance > 0n) {
    const resetHash = await signer.writeContract({
      address: tokenAddress, abi: ERC20_APPROVAL_ABI, functionName: "approve",
      args: [spender, 0n], account,
    });
    const resetReceipt = await reader.waitForTransactionReceipt({ hash: resetHash });
    if (resetReceipt.status !== "success") throw new Error("LEVERUP_ALLOWANCE_RESET_REVERTED");
  }

  const approvalTxHash = await signer.writeContract({
    address: tokenAddress, abi: ERC20_APPROVAL_ABI, functionName: "approve",
    args: [spender, amount], account,
  });
  const receipt = await reader.waitForTransactionReceipt({ hash: approvalTxHash });
  if (receipt.status !== "success") throw new Error("LEVERUP_TOKEN_APPROVAL_REVERTED");
  const confirmedAllowance = await readAllowance();
  if (confirmedAllowance < amount) throw new Error("LEVERUP_ALLOWANCE_STILL_INSUFFICIENT_AFTER_APPROVAL");

  return { status: "APPROVED", traderAddress, tokenAddress, spender,
    allowance: confirmedAllowance.toString(), requiredAmount: amount.toString(), approvalTxHash };
}

/**
 * Read-only simulation of an exact ERC-20 approval for the fixed 1CT spender.
 * Uses eth_call + eth_estimateGas only. It never creates a wallet client or
 * broadcasts a transaction.
 */
export async function simulateLeverUpTokenApproval({ env, tokenAddress, requiredAmount, publicClient }) {
  if (String(env?.LEVERUP_LIVE_TRADING).toLowerCase() !== "false" ||
      String(env?.LEVERUP_KILL_SWITCH).toLowerCase() !== "true") {
    throw new Error("APPROVAL_SIMULATION_REQUIRES_LIVE_OFF_AND_KILL_SWITCH_ON");
  }
  const traderAddress = String(env?.LEVERUP_TRADER_ADDRESS || "");
  if (!isAddress(traderAddress)) throw new Error("LEVERUP_TRADER_ADDRESS_MISSING_OR_INVALID");
  if (!isAddress(tokenAddress) || !APPROVABLE_TOKENS.has(tokenAddress.toLowerCase())) throw new Error("LEVERUP_APPROVAL_TOKEN_NOT_ALLOWLISTED");
  const amount = BigInt(requiredAmount);
  if (amount <= 0n || amount === maxUint256) throw new Error("LEVERUP_APPROVAL_AMOUNT_MUST_BE_PRECISE_AND_POSITIVE");
  const signer = privateKeyToAccount(normalizedKey(env?.LEVERUP_TRADER_PRIVATE_KEY));
  if (signer.address.toLowerCase() !== traderAddress.toLowerCase()) throw new Error("LEVERUP_TRADER_SIGNER_KEY_DOES_NOT_MATCH_TRADER_ADDRESS");
  const rpcUrl = String(env?.LEVERUP_RPC_URL || "https://rpc2.monad.xyz");
  const reader = publicClient || createPublicClient({ chain: MONAD, transport: http(rpcUrl) });
  const spender = LEVERUP_1CT.diamond;
  const [chainId, currentAllowance, nativeBalance, gasPrice] = await Promise.all([
    reader.getChainId(),
    reader.readContract({ address: tokenAddress, abi: ERC20_APPROVAL_ABI, functionName: "allowance", args: [traderAddress, spender] }),
    reader.getBalance({ address: traderAddress }),
    reader.getGasPrice(),
  ]);
  if (chainId !== 143) throw new Error("APPROVAL_SIMULATION_WRONG_CHAIN");
  const request = { address: tokenAddress, abi: ERC20_APPROVAL_ABI, functionName: "approve", args: [spender, amount], account: traderAddress };
  const [simulation, gas] = await Promise.all([reader.simulateContract(request), reader.estimateContractGas(request)]);
  if (simulation?.result === false) throw new Error("APPROVAL_SIMULATION_RETURNED_FALSE");
  const gasCost = BigInt(gas) * BigInt(gasPrice);
  return {
    status: "SIMULATION_PASS", chainId, traderAddress, tokenAddress, spender,
    currentAllowanceRaw: BigInt(currentAllowance).toString(), requiredApprovalRaw: amount.toString(),
    allowanceAlreadySufficient: BigInt(currentAllowance) >= amount,
    estimatedGas: BigInt(gas).toString(), gasPriceWei: BigInt(gasPrice).toString(),
    estimatedGasCostWei: gasCost.toString(), estimatedGasCostMon: formatUnits(gasCost, 18),
    nativeBalanceWei: BigInt(nativeBalance).toString(), nativeBalanceMon: formatUnits(BigInt(nativeBalance), 18),
    sufficientNativeBalanceForEstimatedGas: BigInt(nativeBalance) >= gasCost,
    simulationResult: simulation?.result === undefined ? "CALL_SUCCEEDED" : String(simulation.result),
    transactionBroadcast: false,
  };
}
