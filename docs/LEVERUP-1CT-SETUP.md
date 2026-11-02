# CIEL LeverUp 1CT setup and safety checklist

## Current implementation status

- `src/leverup-1ct.js`: EIP-712 signing and action-data encoding for LeverUp 1CT.
- `src/leverup-readonly.js`: read-only market preflight, live pair/oracle reads, fee-token configuration, onchain position accruals, token balance/allowance reads, and settlement reconciliation.
- `migrations/0002_leverup_execution_ledger.sql`: additive D1 ledger tables for preflight snapshots, position fee snapshots, and closed-settlement reconciliations.
- `scripts/test-leverup-1ct.mjs` and `scripts/test-leverup-readonly.mjs`: safety and accounting tests.
- The LeverUp adapter is not yet wired into the CIEL signal/entry/exit loop. The functions are isolated and tested first. Do not interpret this as live execution being enabled.
- The Cloudflare Worker has not been redeployed with the `background` temporal-dead-zone fix in this change set.

## Hard execution policy

1. Minimum leverage is **50x**. A model inference below 50x means skip the trade; never force it upward.
2. If the applicable notional tier allows less than 50x, skip the market/size.
3. If the inference is above the tier maximum, cap only to that tier maximum, provided it is still at least 50x.
4. Reject stale preflight data (30 seconds), unavailable markets, missing oracle prices, unknown collateral ratio, missing fee data, or insufficient collateral.
5. Exits (full/partial close) must not be blocked by a stale entry preflight.
6. Live execution remains OFF and the kill switch remains ON until the trader wallet, agent, permissions, collateral, fee tokens, and full dry-run have been verified.
7. Never store a private key in GitLab, D1, KV, source code, or a Telegram message.

## Required Cloudflare bindings / variables

Set these on the existing `ciel2` Worker only after confirming the wallet addresses:

| Name | Type | Purpose |
| --- | --- | --- |
| `LEVERUP_TRADER_ADDRESS` | Plain text | Dedicated trader wallet public address; holds WMON and positions |
| `LEVERUP_AGENT_ADDRESS` | Plain text | Public address derived from the hosted agent signing key |
| `LEVERUP_AGENT_PRIVATE_KEY` | Secret | Hosted agent private key; add directly in Cloudflare, never paste into chat or commit |
| `LEVERUP_RPC_URL` | Secret | Dedicated Monad RPC URL (Alchemy preferred over the public rate-limited endpoint) |
| `LEVERUP_LIVE_TRADING` | Plain text | Must remain `false` |
| `LEVERUP_KILL_SWITCH` | Plain text | Must remain `true` |
| `LEVERUP_WMON_COLLATERAL_RATIO` | Plain text | Do not set until the current WMON collateral ratio is verified from LeverUp's UI/API |
| `LEVERUP_MAX_TRADE_MARGIN_MON` | Plain text | Explicit per-trade margin ceiling; do not infer this from the 100 MON total allocation |
| `LEVERUP_TOTAL_ALLOCATION_MON` | Plain text | `100` for the dedicated execution wallet allocation |

The current Cloudflare `ciel2` settings have **no `LEVERUP_*` bindings or secrets**. Existing Telegram/Gemini secrets are unrelated and were not read or changed. The agent-authorization read ABI is not guessed; it must be verified against the deployed Diamond before the account can pass the live signing guard.

## Wallet and token setup

- Chain: Monad mainnet, chain ID `143`.
- LeverUp Diamond: `0xea1b8E4aB7f14F7dCA68c5B214303B13078FC5ec`.
- WMON: `0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A` (18 decimals).
- LVMON: `0x91b81bfbe3A747230F0529Aa28d8b2Bc898E6D56` (18 decimals).
- 1CT accepts ERC-20 collateral only. MON must be wrapped to WMON before use.
- The trader must approve the Diamond for WMON collateral and for each enabled 1CT fee token actually selected. Approval is separate from agent authorization.
- The 1CT execution fee configuration is fetched from `/v2/trading/anti-ddos-config` and refreshed/cached for 60 seconds. Fee-token selection must include the trade's own WMON spend when WMON is also the fee token.
- Agent permissions should be restricted to the operations CIEL needs: bit 0 MARKET_OPEN, bit 1 MARKET_CLOSE, and bit 9 PARTIAL_CLOSE. Do not grant wildcard/ALL unless explicitly required later.

## Live market and cost checks

Every entry preflight must capture, at one onchain block where possible:

- Market status and `pairBase` from `GET /v1/pairs`.
- Applicable notional tier and max leverage from `getPairByBaseV4`.
- Global minimum notional and the market's minimum holding seconds.
- Latest pair price and MON/USD price from `POST /v1/oracle/price/pairs/latest`.
- Pair open/close fee configuration and long/short holding fee rates.
- Current signed funding rate from `getMarketInfoV2`.
- Current 1CT anti-DDOS fee configuration and fee-token balance/allowance.
- Trader WMON balance/allowance and current agent authorization/permissions.

Cost formulas used for projections:

- Open/close fee USD = position notional USD × live fee percentage / 10,000.
- Holding fee USD = position notional USD × seconds held × side-specific holding fee rate / 1e12.
- Funding projection uses the current signed per-second rate / 1e18 and the side convention. Funding can change as open interest changes, so it is a projection, not a guarantee.
- Actual funding and holding totals come from onchain `getPositionsV4` (`fundingFee`, `holdingFee`).
- Final actual values come from the closed position's `closeInfo` (`fundingFee`, `holdingFee`, `closeFee`, `pnl`) plus the position's `openFee`.
- Do not use the indexed open-position record as live accrued fees: it is an open-time snapshot. Use `getPositionsV4` for current accruals.

## Important unresolved input

The WMON collateral ratio is not returned in the public `GET /v1/pairs` response or the documented pair-view structure. LeverUp's AnyCollateral guidance says collateral ratios can change and must be checked in the order panel at trade time. A published example uses 70%, but that is not a live value and must not be hardcoded. The code therefore requires a verified ratio and fails closed if it is missing. Do not substitute the 15% maintenance-margin figure for the WMON collateral ratio; they are different concepts.

The venue minimum notional is read from the live contract, not hardcoded. Minimum WMON collateral is calculated from the current MON/USD price, selected leverage, and verified WMON collateral ratio. This is why the old approximate 22 MON at 50x / 11 MON at 100x figures are not hardcoded.

## Remaining implementation / activation sequence

1. Confirm the exact trader wallet and agent public addresses.
2. Verify the agent's onchain authorization and nonce using the exact deployed Diamond ABI. The current public docs do not expose enough ABI detail to safely hardcode this reader, so this check is deliberately not guessed. The signing guard requires a verified authorization object before it can submit.
3. Read WMON and all enabled fee-token balances/allowances. No approvals are sent automatically.
4. Verify the current WMON collateral ratio from the live LeverUp UI/API.
5. Finish integrating preflight and account-state checks into the CIEL signal candidate loop.
6. Add idempotent entry/exit intent orchestration and persist preflight, position accrual and settlement records to the new D1 tables.
7. Apply the D1 migration to the existing staging D1 database.
8. Run a full dry-run using live prices and current account state. No intent submission.
9. Only after explicit approval: deploy the code with live trading still OFF, verify endpoints, and separately decide whether to enable the kill switch / live trading.

Official references:
- https://developer-docs.leverup.xyz/gasless/overview
- https://developer-docs.leverup.xyz/gasless/authorization
- https://developer-docs.leverup.xyz/gasless/fees
- https://developer-docs.leverup.xyz/gasless/actions
- https://developer-docs.leverup.xyz/gasless/signing
- https://developer-docs.leverup.xyz/api/pairs
- https://developer-docs.leverup.xyz/api/oracle
- https://developer-docs.leverup.xyz/api/positions
- https://developer-docs.leverup.xyz/api/history
- https://developer-docs.leverup.xyz/onchain/reading-data
- https://leverup.gitbook.io/docs/trading/fee-breakdown
- https://leverup.gitbook.io/docs/liquidity-layer/anycollateral
