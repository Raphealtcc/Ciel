# CIEL

Hyperliquid market monitoring, technical setup detection, local statistical forecasting, Gemini market-context review, Telegram trade cards, manual position tracking, and automatic paper trading on Cloudflare Workers.

- Live Worker: https://ciel.leno3z4rrrri.workers.dev
- Health endpoint: https://ciel.leno3z4rrrri.workers.dev/health
- Exact deployed bundle SHA-256: `24e6452b4a2854a1e37f864adcb201d588771460eed68bcd100f5cfbafd564b6`
- Current live version: 505 (100% allocation); production has not been changed by this audit.

## Repository branches

- `main`: byte-exact recovered production baseline.
- `audit/paper-trading-fix`: isolated paper-tier staging patch, behavioral tests, current source-account audit and account handoff. Do not merge to `main` or deploy to the source account yet.

## Layout

- `recovered-src/`: recovered JavaScript module fragments from the deployed bundle. Treat as immutable evidence.
- `cloudflare-export/`: compressed original Worker export, split into chunks.
- `scripts/`: exact bundle reconstruction, isolated staging patch, behavioral tests and REA summary helper.
- `migrations/0000_recovered_live_schema.sql`: recovered live D1 schema; this is not a data backup.
- `docs/`: architecture, runtime snapshot, REA findings, live Cloudflare audit and account handoff.
- `wrangler.jsonc`: new-account staging template only. It contains explicit placeholder D1/KV IDs and uses SQLite-backed Durable Object migrations. It does not point to the source account.

## Verify

Requires Node.js and npm.

```sh
npm run check
npm run check:paper
```

- `npm run check` reconstructs the exact deployed bundle, verifies its length and SHA-256, and runs Node syntax validation.
- `npm run check:paper` reconstructs the baseline, applies the patch to `reconstructed/patched-worker.js`, syntax-checks that candidate, and runs deterministic paper-entry, P&L, close-lifecycle, profit-protection and Telegram-copy tests.
- The patch never edits `recovered-src/` or `reconstructed/worker.js`.

## Paper trading

The production baseline uses a 60 MON starter paper ledger, 22 MON margin and 50x simulation. The isolated staging patch enables the 11 MON / 100x conservative baseline for markets whose verified maximum leverage is 100x, while preserving 22 MON / 50x for 50x markets. It corrects BTC/ETH to 100x, keeps advisor recommendations running even when paper cash is insufficient, and keeps the setup card, open notification, `/help` and `/profits` labels consistent with the actual simulated tier. It deliberately leaves 25x/5x/3x markets out until minimum-hold and collateral behavior are modeled.

The market leverage map is hardcoded, but the current 25-symbol watchlist was checked against LeverUp pair API + Monad Diamond (23 pool markets) or Hyperliquid public metadata (2 markets). The staging map has zero mismatches; BTC/ETH were corrected from 1001x to 100x. The verified global minimum notional is $20. Exact MON collateral still depends on live CR and order-panel rounding. Current Hyperliquid feed coverage is 24/25 priced symbols and 23/25 books: QNT has no price/book and KPEPE has no book. The simulator is gross and mark-based; it does not model fees, funding, spread, slippage, gap-through fills, LeverUp collateral ratio, mark/oracle differences or liquidation. Do not interpret its paper P&L as LeverUp execution profitability.

## Staging safety

Do not deploy the template until:
1. The target account has its own D1 database and KV namespace and their IDs replace the placeholders.
2. The target Durable Object namespaces are created with the declared `new_sqlite_classes` migration.
3. The recovered D1 schema is reviewed and applied to the target database.
4. Fresh Gemini/Telegram secrets are configured outside Git. Use a separate Telegram bot for staging so its webhook does not overwrite the live bot's webhook.
5. The staging Worker has a separate name and does not receive production traffic.

No LeverUp order credentials are configured. CIEL remains advisory-only; paper trading is automatic and separate from manual START TRACKING.

## Recovery limits

Cloudflare exposed the deployed JavaScript bundle, not the original TypeScript project. Original TypeScript, original source maps, package lock, test suite, and release pipeline were not recovered. The D1 schema is in GitLab, but D1 row data, KV values, Durable Object state and secret plaintext are not. The paper ledger lives inside the feed Durable Object and its internal KV key cannot be read through the available Cloudflare SQL query API.

See `docs/HANDOFF-2026-11-02.md` before changing the connected Cloudflare account. It records the source account, live Worker, bindings, resource IDs, secret names, current D1 activity and what cannot be cloned.


## Current live coverage and account-switch warning

The latest 14-route GitLab smoke test reached the live Worker. Health was connected/open/fresh; 25 markets were listed, 24 had prices and 23 had order books. QNT is missing price/book and KPEPE is missing a book. The sampled BTC, ETH, MON, ONDO and ADA books were fresh. Do not treat a healthy global feed flag as proof that every symbol has full market-quality data.

Do not connect the second Cloudflare account until the account-switch preflight is reviewed. The source secrets and Durable Object paper ledger are not exportable through the available API. The new staging Worker must use new D1/KV/DO resources and a separate Telegram bot.
