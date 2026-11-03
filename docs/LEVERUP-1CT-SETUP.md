# CIEL LeverUp 1CT setup and safety checklist

## Current implementation status

- `src/leverup-1ct.js`: EIP-712 signing and action-data encoding for LeverUp 1CT.
- `src/leverup-readonly.js`: read-only market preflight, live pair/oracle reads, fee-token configuration, onchain position accruals, agent authorization/nonce reads, token balance/allowance reads, and settlement reconciliation.
- `migrations/0002_leverup_execution_ledger.sql`: additive D1 ledger tables for preflight snapshots, position fee snapshots, and closed-settlement reconciliations. The tier-specific max leverage column is included to match the persistence insert.
- `scripts/test-leverup-1ct.mjs` and `scripts/test-leverup-readonly.mjs`: safety and accounting tests.
- `src/leverup-advisor.js` connects fully confirmed CIEL approvals to a read-only LeverUp account snapshot and market-open preflight. Successful and permission-rejected preflights are persisted to the additive D1 ledger and KV.
- `scripts/apply-leverup-integration.mjs` injects that coordinator into the recovered Worker build; the Telegram trade card shows the actual LeverUp preflight result.
- The integration rejects unknown collateral ratios, existing open LeverUp positions, missing WMON balance/allowance, unsupported tiers, missing market data, and missing market-open permission.
- Exact token approval is wired into the guarded live submission coordinator. It validates the trader key against `LEVERUP_TRADER_ADDRESS`, allowlists WMON/LVMON/USDC/LVUSD, approves only the exact amount required by the current intent, waits for confirmation, and rereads allowance. It refuses to run unless `LEVERUP_LIVE_TRADING=true` and `LEVERUP_KILL_SWITCH=false`.
- The CIEL approved-signal path now has a D1 idempotency claim, exact allowance preparation, guarded EIP-712 submission, ambiguous-submission quarantine, status polling/reconciliation, and on-chain position confirmation. An uncertain submit is never automatically replayed.
- The minute cron runs read-only account diagnostics, open-position monitoring, fee snapshots, stop/target/max-hold checks, configured partial take-profits, and closed-position settlement reconciliation. It only submits management intents when live mode is explicitly enabled.
- The current Worker configuration remains `LEVERUP_LIVE_TRADING=false` and `LEVERUP_KILL_SWITCH=true`. No approval or order transaction is permitted in the deployed configuration.

## Confirmed public wallet identities

- Trader wallet: `0xd422fc040ad9294d553150Cf5646Ab0B1729E443`
- Agent wallet: `0x77DF3ae15b994131797905e59675da3544C90DFF`

These are public addresses only. The trader wallet remains the owner of funds and positions. The agent key is an intent signer and must never be given the trader wallet's private key.

## Hard execution policy

1. Minimum leverage is **50x**. A model inference below 50x means skip the trade; never force it upward or fall back to 25x/10x/5x/2x.
2. If the applicable notional tier allows less than 50x, skip the market/size.
3. If the inference is above the tier maximum, cap only to that tier maximum, provided it is still at least 50x.
4. Reject stale preflight data (30 seconds), unavailable markets, missing oracle prices, unknown collateral ratio, missing fee data, or insufficient collateral.
5. Exits (full/partial close) must not be blocked by a stale entry preflight.
6. Live execution remains OFF and the kill switch remains ON. No agent authorization, approvals, wrapping, order submission or other wallet transaction is performed by this integration work.
7. Never store a private key in GitLab, D1, KV, source code, or a Telegram message.

## Required Cloudflare bindings / variables

The staging `wrangler.jsonc` now contains the two confirmed public addresses and explicit hard-off controls:

| Name | Type | Value / purpose |
| --- | --- | --- |
| `LEVERUP_TRADER_ADDRESS` | Plain text | `0xd422fc040ad9294d553150Cf5646Ab0B1729E443` |
| `LEVERUP_AGENT_ADDRESS` | Plain text | `0x77DF3ae15b994131797905e59675da3544C90DFF` |
| `LEVERUP_LIVE_TRADING` | Plain text | `false` |
| `LEVERUP_KILL_SWITCH` | Plain text | `true` |
| `LEVERUP_MIN_LEVERAGE` | Plain text | `50` |
| `LEVERUP_MAX_DAILY_LOSS_MON` | Plain text | `9` |
| `LEVERUP_MAX_DRAWDOWN_MON` | Plain text | `9` |
| `LEVERUP_MAX_AGGREGATE_STOP_RISK_MON` | Plain text | `6` |
| `LEVERUP_TOTAL_ALLOCATION_MON` | Plain text | `50` MON total capital ceiling |\n| `LEVERUP_PREFLIGHT_ENABLED` | Plain text | `true` |\n| `LEVERUP_RESERVE_MON` | Plain text | `25` MON reserved; only the minimum venue margin is used unless a per-trade cap is configured |
| `LEVERUP_AGENT_PRIVATE_KEY` | Secret | Agent intent-signing key; configure only through Cloudflare secret management |
| `LEVERUP_TRADER_PRIVATE_KEY` | Secret | Trader-only ERC-20 approval signer; configure only through Cloudflare secret management |
| `LEVERUP_AUTO_APPROVE` | Plain text | `true`; exact-amount approvals only, and only when live trading is explicitly enabled and kill switch is off |
| `LEVERUP_RPC_URL` | Secret | Not configured; use a dedicated Monad RPC provider |
| `LEVERUP_COLLATERAL_50X_USD` | Plain text | `0.43` USD minimum collateral at 50x |\n| `LEVERUP_COLLATERAL_100X_USD` | Plain text | `0.23` USD minimum collateral at 100x; linear interpolation between 50x and 100x; 0.23 USD floor above 100x |
| `LEVERUP_MAX_TRADE_MARGIN_MON` | Plain text | Intentionally unset; no per-trade budget has been authorized |

The additive migrations `0002_leverup_execution_ledger.sql` and `0003_leverup_execution_coordination.sql` are applied to the isolated `ciel-paper-staging` D1 database; all five LeverUp tables were verified. On 2026-11-03, the main-branch read-only CIEL/LeverUp preflight bundle was deployed to the isolated `ciel2` Worker (version `09e69cf9-4a29-4643-bdf7-cf0ab8f74dfa`, deployment `294ad345-78d7-4cea-868a-b4014dc5b694`). The public health endpoint returned HTTP 200, and the protected diagnostics endpoint returned HTTP 401 when called without authorization. All six existing secret bindings, D1, KV, Durable Object namespaces, exports, and the one-minute cron schedule were preserved. Live trading remains `false`, the kill switch remains `true`, and no wallet approval or order was submitted. The approval helper remains isolated in source and is not yet wired into a live order lifecycle.

## Wallet and token setup

- Chain: Monad mainnet, chain ID `143`.
- LeverUp Diamond: `0xea1b8E4aB7f14F7dCA68c5B214303B13078FC5ec`.
- WMON: `0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A` (18 decimals).
- LVMON: `0x91b81bfbe3A747230F0529Aa28d8b2Bc898E6D56` (18 decimals).
- 1CT accepts ERC-20 collateral only. MON must be wrapped to WMON before use.
- The trader must approve the Diamond for WMON collateral and for each enabled 1CT fee token actually selected. Approval is separate from agent authorization.
- The 1CT execution fee configuration is fetched from `/v2/trading/anti-ddos-config` and refreshed/cached for 60 seconds. Fee-token selection must include the trade's own WMON spend when WMON is also the fee token.
- Intended agent permissions are restricted to market open (bit 0), market close (bit 1), and partial close (bit 9). Do not grant wildcard/ALL permissions. Verify the exact onchain authorization before any execution.

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

The Worker no longer invents a protocol collateral-ratio value. It uses the operator-provided minimum collateral schedule: $0.43 at 50x, $0.23 at 100x, linearly interpolated for 50x–100x, and $0.23 as the conservative floor above 100x. The amount is scaled proportionally to the live global minimum notional, then converted to WMON using LeverUp's live MON/USD oracle. The equivalent ratio is derived only to satisfy the existing sizing interface. Live market tier, notional, price, balance, fee, and margin checks remain mandatory. These are operator-supplied operating minimums, not a claim that LeverUp publishes a fixed collateral ratio.

The venue minimum notional is read from the live contract, not hardcoded. Minimum WMON collateral is calculated from the current MON/USD price, selected leverage, and verified WMON collateral ratio. The total 50 MON ceiling is not a per-trade allocation. The current per-trade margin ceiling is 25 MON, with 25 MON reserved.

## Remaining implementation / activation sequence

1. Read `getAgentAuth` and `getLastNonce`; verify the agent is authorized for the required action bits (0 open, 1 close, 9 partial close).
2. Read WMON and all enabled fee-token balances/allowances. No approvals are sent automatically.
3. Verify the current WMON collateral ratio from the live LeverUp UI/API.
4. Finish integrating preflight and account-state checks into the CIEL signal candidate loop.
5. Add idempotent entry/exit intent orchestration and persist preflight, position accrual and settlement records to the new D1 tables.
6. Apply the D1 migration to the isolated staging D1 database.
7. Run a full dry-run using live prices and current account state. No intent submission.
8. Only after explicit approval: deploy the code with live trading still OFF, verify endpoints, and separately decide whether to enable live execution.

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
