# LeverUp market-tier verification — 2026-11-02

## Result

The market metadata check completed successfully against Monad mainnet and LeverUp's public pair API.

- Chain ID: `143` (Monad mainnet)
- RPC: `https://rpc.monad.xyz`
- LeverUp Diamond: `0xea1b8E4aB7f14F7dCA68c5B214303B13078FC5ec`
- Pair API: `https://service.leverup.xyz/v1/pairs?size=100&block_chain=MONAD`
- Pair API total: 77
- CIEL watchlist checked: 25
- Missing pairs: 0
- Per-market verification errors: 0
- Hyperliquid metadata errors: 0
- Global minimum notional from `getTradingConfig()`: **$20**
- Source-map mismatches: BTC and ETH only (recovered source said 1001x; current market metadata says 100x)
- Patched staging-map mismatches: **0**

23 pool markets were checked against LeverUp Diamond `getPairByBaseV4(address)`. CASHCAT and PONS use the Hyperliquid execution venue and were checked against Hyperliquid public metadata. Every watchlist entry returned an available pair/market record.

## Verified maximum leverage by CIEL watchlist market

| Max leverage | Markets |
|---:|---|
| 100x | BTC, ETH, XRP, SOL |
| 50x | BNB, HYPE, ONDO, KPEPE, TRX, AAVE, ADA, DOGE, LINK, PUMP, SEI, SUI, UNI, VIRTUAL |
| 25x | MON, ZEC, XMR |
| 5x | QNT, LIT |
| 3x | CASHCAT, PONS |

The generic LeverUp documentation advertises up to 1001x on eligible markets. That is not a promise that every pair supports 1001x. For this exact CIEL watchlist, the current pair-level data reports 100x maximum for BTC and ETH, not 1001x. The staging patch corrects those two values. The other 23 watchlist entries already match the checked market metadata.

## What the minimum-collateral numbers mean

The on-chain global minimum notional is $20. For MON collateral, the rough minimum collateral calculation is:

`minimum MON ≈ 20 USD ÷ (MON/USD price × selected leverage × MON collateral ratio)`

This is before any additional fee, slippage, rounding or interface-specific constraints. The collateral ratio (CR) is not a permanent constant: LeverUp's AnyCollateral guidance says effective margin equals deposited value multiplied by CR, and CR can change. The current CR shown in LeverUp's order panel is the source of truth at entry.

Using the $0.019208 MON/USD reference shown in the user's ONDO notification, the $20 minimum notional implies these approximate amounts at 100% CR:

| Leverage | Minimum MON at 100% CR | Approx. MON at 95% CR |
|---:|---:|---:|
| 100x | 10.41 → 11 MON | 10.96 → 11 MON |
| 50x | 20.82 → 21 MON | 21.92 → 22 MON |
| 25x | 41.65 → 42 MON | 43.84 → 44 MON |
| 10x | 104.12 → 105 MON | 109.60 → 110 MON |
| 5x | 208.25 → 209 MON | 219.20 → 220 MON |
| 3x | 347.08 → 348 MON | 365.35 → 366 MON |
| 2x | 520.61 → 521 MON | 547.00 → 547 MON |

These are calculations from the verified $20 notional floor and the stated MON reference price, not a claim that LeverUp will accept those exact rounded amounts in every live order. The live CR and order panel can raise the requirement. The user's observed 22 MON at 50x and 11 MON at 100x are consistent with the order-of-magnitude of this calculation, but the current MON CR was not independently read from the live order panel during this audit.

At 100% CR and $0.019208 MON:
- 22 MON × 50x ≈ $21.13 notional.
- 11 MON × 100x ≈ $21.13 notional.

This explains why 5x is not feasible with a 60 MON paper account: the estimated requirement is over 200 MON before any CR haircut. A 10x or 2x market would also exceed that account's balance. A 25x market could be within 60 MON at the example price, but has an additional execution restriction described below.

## Per-market restrictions captured

The verification report also records per-pair:
- maximum leverage tiers and tier notional caps;
- raw initial-loss and liquidation-loss parameters;
- slippage configuration;
- open/close fee parameters;
- long/short open-interest caps;
- funding and holding-fee rate fields;
- minimum holding time.

The following five markets report a 180-second minimum holding period:
- 25x: MON, ZEC, XMR
- 5x: QNT, LIT

The other 20 watchlist markets report zero in the pair API's `minHoldingSeconds` field.

The current paper simulator does not enforce these minimum-hold restrictions. Therefore the isolated staging patch deliberately supports only the 50x and 100x tiers for now. It does not paper-trade 25x, 5x or 3x markets. This is conservative rather than a claim that all 25x markets are unaffordable. Before enabling 25x, the paper engine must respect the 180-second hold restriction and the margin amount must use current MON price and CR. The 5x/3x tiers remain unaffordable against a 60 MON starting paper balance at the example MON price.

## Paper engine implications

The staging patch:
- changes BTC and ETH from the incorrect 1001x map value to the verified 100x;
- allows 50x markets at the configured 22 MON paper margin;
- allows 100x markets at the configured 11 MON paper margin;
- simulates markets with maximum leverage >=100x at 100x, never at 1001x;
- keeps 25x/5x/3x markets out of automatic paper entry until their collateral and minimum-hold behavior is modeled;
- does not change production Worker version 505.

The 22/11 MON paper values are the user's observed current illustrative tiers, not a dynamic CR oracle. The paper engine is still a gross Hyperliquid-mid simulation. It does not simulate LeverUp Pyth fills, current MON CR, per-pair slippage, open/close fees, funding/holding fees, collateral haircuts, gaps or liquidation. The Telegram copy now makes the Hyperliquid-vs-LeverUp execution difference explicit.

## Reproduction

Run:

`npm run verify:leverup`

This reassembles the recovered source, applies the isolated staging patch, runs paper behavior tests, and then checks the live pair API, Monad Diamond and Hyperliquid metadata. The CI job stores `leverup-market-tier-audit.json` as an artifact for 30 days.

Sources:
- [LeverUp docs: protocol overview](https://leverup.gitbook.io/docs)
- [LeverUp AnyCollateral guide: CR discounts and changes](https://lp-blog-production.up.railway.app/how-to-use-anycollateral-on-leverup/)
- [LeverUp liquidation guide](https://leverup.gitbook.io/docs/trading/liquidation)

**Decision:** Market max leverage and the $20 global minimum notional are verified for the current watchlist. Exact MON collateral minima still depend on the live CR and order-panel rounding. The patched staging map matches all 25 checked markets; production remains untouched.
