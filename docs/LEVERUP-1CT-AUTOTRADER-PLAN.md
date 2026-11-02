# CIEL LeverUp 1CT autonomous execution — implementation plan

Status: **DESIGN / NOT DEPLOYED / LIVE EXECUTION OFF**

Base: `main` at `8189c481681d92e9fb04d50cb03423b9d8bd4a2b`
Branch: `feature/leverup-1ct-autotrader`

## 1. Integration decision

Use LeverUp **1CT hosted-agent mode**. CIEL's backend holds a dedicated 1CT signing key; the trader wallet authorizes that agent once with `authorizeAgent(agent, name, permissions)`. Subsequent EIP-712 intents are signed by the agent key and relayed through:

- Service: `https://oneclick-01-keeper.leverup.xyz`
- Submit: `POST /v2/trading/submit-intent?blockchain=MONAD`
- Status: `GET /v2/trading/{intent_hash}/status`
- Fee config: `GET /v2/trading/anti-ddos-config` (refresh/cache every 60 seconds)
- Chain: Monad, chain ID 143
- Diamond: `0xea1b8E4aB7f14F7dCA68c5B214303B13078FC5ec`

This is not a custodial LeverUp subaccount. LeverUp positions are merged by trader wallet + pair + direction + lvToken. **Use a dedicated trader wallet** for CIEL rather than the wallet used for manual positions. Fund it with only the amount allocated to this strategy. Keep the wallet's main private key outside CIEL.

## 2. Key and permission model

- Generate a new agent signing key specifically for this CIEL deployment.
- Store its private key only as a Cloudflare Worker secret (never GitLab variables committed to repo, D1, KV, logs, Telegram, or source).
- Never store the trader wallet's private key in CIEL.
- Trader wallet signs one onchain `authorizeAgent` transaction after reviewing the agent address and permissions.
- Use explicit permission bits, never the `uint256.max` wildcard.
- Initial intended permissions: `MARKET_OPEN(0)`, `MARKET_CLOSE(1)`, `UPDATE_TP_SL(7)`, `PARTIAL_CLOSE(9)`, `CANCEL_DECREASE_ORDER(10)`, `BATCH_CREATE_DECREASE_ORDERS(11)`, `BATCH_UPDATE_DECREASE_ORDERS(12)`, `CANCEL_ALL_DECREASE_ORDERS(13)`.
- Explicitly exclude `ADD_MARGIN(5)`, `REMOVE_MARGIN(6)`, and limit-order actions until a demonstrated strategy need exists.
- Revoke the agent onchain before deleting/rotating its key.

The key is an intent signer, not a wallet delegate: LeverUp's documented action set does not include token transfers, withdrawals, or approvals. Permission checks are enforced onchain. Cloudflare secret storage still means the Worker runtime can use the key; production key custody must be reviewed before enabling real orders.

## 3. Collateral and account setup

1CT requires ERC-20 collateral. Native MON is not accepted directly; wrap MON to WMON first.

- WMON `tokenIn` settles as LVMON `lvToken`.
- USDC settles as LVUSD.
- Approve the LeverUp Diamond for the collateral token and the selected 1CT execution-fee token.
- Do not assume an approval is already present.
- Do not automate wrapping, funding, approvals, or agent authorization in the first implementation. Those are explicit wallet-owner setup actions.

## 4. Execution architecture

Keep the existing Hyperliquid market feed and CIEL signal generation intact. Add a separate LeverUp execution adapter and an execution coordinator. The coordinator consumes only eligible, fresh, approved CIEL candidates and reconciles against LeverUp's own pair/oracle/position data.

Pre-trade checks must include:

- Signal is eligible and has not already been consumed (idempotency key).
- Market exists in the live `GET /v1/pairs` list and status is `AVAILABLE`.
- Live pair-level leverage, tier/notional limits, min holding time and fee/slippage configuration are checked; never rely on a static max-leverage map.
- Fresh LeverUp oracle price is fetched immediately before intent construction; compare it with the Hyperliquid signal price and enforce a configured divergence bound.
- Current MON/USD and collateral conversion are not taken from the Hyperliquid MON mid as if it were the LeverUp collateral oracle.
- Exact `tokenIn`/`lvToken` pair is validated.
- Margin, notional, leverage, stop distance, estimated open/close fees, holding/funding costs, and execution fees fit the configured budget and risk limits.
- Worst acceptable market price is computed with a hard slippage bound.
- No duplicate or conflicting open position exists for the dedicated trader wallet.
- No order is sent if any input is missing, stale, inconsistent, or cannot be verified.

LeverUp's global minimum notional was previously verified at $20, but actual MON collateral minima depend on current collateral ratio (CR), market tier, token decimals, and rounding. The prior observed 22 MON at 50x / 11 MON at 100x are operating observations, not hardcoded guarantees. Recalculate the required margin at each preflight; reject if the venue minimum cannot be met without exceeding the configured budget.

1CT uses:
- `qty` in base asset units at 1e10;
- prices at 1e18;
- `amountIn` in `tokenIn` decimals;
- `nonce` as a millisecond uint64 sent as a JSON string;
- a short per-intent deadline;
- EIP-712 domain `LeverupOneClickV2`, version `1`, chain ID `143`, verifying contract = Diamond.
- `actionData = abi.encode(trader, ...actionParams)` with the leading trader word stripped. Dynamic action arrays must retain the trader-prefixed ABI offset layout.

Never treat HTTP 200 from submit-intent as a filled trade. Poll intent status, then reconcile the actual position from LeverUp indexed/onchain data. Opens can be accepted before a position is indexed; closes/partial closes/TP-SL creation may return 404 until indexing catches up. Retry only with bounded backoff and idempotency protection.

## 5. CIEL strategy and risk separation

Initial strategy scope: BTC, ETH and SOL core scalp candidates only. Preserve the existing deterministic strategy and advisory output; do not automatically promote every alert or every market move into a live trade.

The execution coordinator must independently enforce:
- maximum leverage per market and a global configured leverage ceiling;
- per-trade maximum margin and notional;
- per-trade maximum loss at stop;
- aggregate open-position stop-risk ceiling;
- maximum concurrent positions;
- daily realised-loss stop and rolling drawdown stop;
- maximum spread / oracle divergence / slippage;
- maximum holding time and forced exit handling;
- market min-hold restrictions;
- one active CIEL-managed position per symbol/direction/collateral slot;
- kill switch on stale feed, missing oracle, missing position reconciliation, API errors, or uncertain execution status.

Do not copy paper account balances, paper P&L, or paper sizing assumptions into the live ledger. Live positions, fills, fees, funding, and realized P&L must come from LeverUp records, not Hyperliquid mark-price estimates.

## 6. Hard-off rollout

The first implementation must be **non-executing by construction**:

- `CIEL_LIVE_TRADING_ENABLED` defaults to `false` and missing configuration means OFF.
- No secret agent key means OFF.
- No trader address means OFF.
- No verified onchain authorization means OFF.
- No live intent submission in dry-run mode.
- Dry-run returns the exact proposed action, encoded units, checks, rejection reasons and estimated risk, but must not sign or POST an intent.
- The enable flag is not exposed through public HTTP or Telegram commands.
- Add an explicit kill switch checked before every order and every management action.
- Add tests proving missing/false flags never call the signer or submit endpoint.
- Do not add secrets or change Cloudflare settings as part of this branch.
- Do not deploy this branch. The existing production Worker remains read-only.

Only after dry-run parity, reconciliation tests, and a separate wallet authorization review should we discuss enabling live execution.

## 7. Implementation sequence

1. Add the 1CT client (action-data encoding, typed-data signing, fee selection, submit/status polling) with unit tests against the documented reference format.
2. Add read-only LeverUp market/price/position adapter and preflight diagnostics.
3. Add persistent execution intents and idempotent reconciliation without enabling submission.
4. Connect approved CIEL BTC/ETH/SOL scalp candidates to a dry-run execution coordinator.
5. Test rejection cases, stale data, duplicate signals, fee changes, min-notional/CR changes, indexing lag, partial closes and kill-switch behavior.
6. Review agent permissions and dedicated trader wallet setup with the owner.
7. Keep live execution OFF until the owner explicitly authorizes a separate enablement step.

## 8. Source documentation

- LeverUp 1CT overview: https://developer-docs.leverup.xyz/gasless/overview
- Agent authorization: https://developer-docs.leverup.xyz/gasless/authorization
- Security model: https://developer-docs.leverup.xyz/gasless/security
- Action reference: https://developer-docs.leverup.xyz/gasless/actions
- Signing: https://developer-docs.leverup.xyz/gasless/signing
- Fees: https://developer-docs.leverup.xyz/gasless/fees
- Submit and track: https://developer-docs.leverup.xyz/gasless/submit
- Pair metadata: https://developer-docs.leverup.xyz/api/pairs
- Oracle prices: https://developer-docs.leverup.xyz/api/oracle
- Positions: https://developer-docs.leverup.xyz/api/positions
- Core concepts: https://developer-docs.leverup.xyz/introduction/concepts
