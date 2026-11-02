# CIEL live recovery audit — 2026-11-02

Read-only continuation of the original Cloudflare-to-GitLab recovery. Checked at approximately 2026-11-02 00:31 UTC. No production Cloudflare resources, secrets, schedules, bindings, D1 rows, KV values, or Durable Object state were changed.

## Account preservation

- Connected Cloudflare profile: `leno3z4rrrri@gmail.com`
- Account ID: `479908018ec0f3099f920b1a7751aadb`
- Workers.dev subdomain: `leno3z4rrrri`
- The connection was not switched. Keep this source account connected until the target staging account is ready and its inventory is preserved.

## Cloudflare inventory

### Workers

| Script | State |
|---|---|
| `ciel` | Production source; version 505; 100% deployment allocation |
| `ciel-audit-probe-20261101` | Separate leftover probe; no bindings, secrets, or cron schedule |

Production Worker:
- URL: https://ciel.leno3z4rrrri.workers.dev
- Version ID: `2c5ea0a1-1608-4f79-9013-86ddcac0c42a`
- Deployment ID: `431af2ec-8ce0-49c3-a222-b1c3a683af41`
- Compatibility date: `2026-09-08`
- Compatibility flag: `nodejs_compat`
- Handlers: `fetch`, `scheduled`
- Cron: `* * * * *`
- Deployment allocation: 100% version 505
- Latest production upload: 2026-10-31 17:34:05 UTC

### Bindings and secrets

Production bindings:
- `DB`: D1 `ciel`, ID `fb55e85b-af9b-45b3-ba43-6c7f7996dfa8`
- `CIEL_STATE`: KV `ciel_state`, ID `8b5c4b6078ce43a8aec4d9343855a70f`
- `HYPERLIQUID_FEED`: SQLite Durable Object namespace, class `HyperliquidFeed`, ID `23b7406149df46e1b737473441be73ca`
- `TRADING_ENGINE`: SQLite Durable Object namespace, class `TradingEngine`, ID `116d1ec659a640c297efdf3326a4a90c`

Secret binding names present (plaintext is not returned by Cloudflare and was not copied):
- `GEMINI_API_KEY_1` through `GEMINI_API_KEY_7`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `TELEGRAM_WEBHOOK_SECRET`

No LeverUp API credential binding exists.

### Other account resources

- D1 databases: `ciel` and legacy `infotrader_state`
- KV namespaces: `ciel_state` and legacy `infotrader-state`
- Pages projects: 0
- Durable Object namespaces: 2; both SQLite-backed
- HyperliquidFeed namespace: one object with stored data
- TradingEngine namespace: zero objects
- R2: the account API returned an R2-not-enabled/permission response. Do not claim an empty bucket inventory until R2 is enabled and queried.
- The legacy `infotrader_state` database and `infotrader-state` KV namespace are separate applications and must not be merged into CIEL staging.

### Configuration drift

The live Worker has these plain-text values:
- `ADVISORY_COLLATERAL_MON=10`
- `ADVISORY_LEVERAGE=100`
- `ADVISORY_MAX_HOLD_MINUTES=90`
- `ADVISORY_MIN_CONFIDENCE=0.72`
- `ALERT_COOLDOWN_MINUTES=15`
- `ALERT_WINDOW_MINUTES=5`
- `GEMINI_MODEL=gemini-3.5-flash-lite`
- `GEMINI_REVIEW_COOLDOWN_MINUTES=15`
- `MOVE_ALERT_PCT=2.0`
- `WATCH_SYMBOLS`: 25 symbols

Recovered-bundle reference search shows that `ADVISORY_COLLATERAL_MON`, `ADVISORY_LEVERAGE`, `ADVISORY_MAX_HOLD_MINUTES`, and `GEMINI_REVIEW_COOLDOWN_MINUTES` are stale/unreferenced. The deployed source path still uses 22 MON / 50x constants for paper entries. The staging patch replaces the misleading hardcoded setup-card and notification copy with tier-aware values. Trend review uses `ADVISORY_TREND_REVIEW_COOLDOWN_MINUTES` with a 30-minute default; that variable is not set on the source Worker.

## D1 live state

Database: `ciel`; application schema: 16 tables and 14 named indexes. Read-only counts at 2026-11-02 00:31 UTC:

| Table | Rows |
|---|---:|
| advisor_ai_audit | 944 |
| advisor_positions | 234 |
| live_executions | 1 |
| live_positions | 1 |
| market_alerts | 67 |
| market_book_snapshots | 6,634 |
| market_candle_hourly_stats | 2,456 |
| market_candles | 20,104 |
| market_context_snapshots | 44,261 |
| market_samples | 96,095 |
| market_snapshots | 63,226 |
| paper_executions | 0 |
| positions | 0 |
| signals | 1 |
| tokens | 191 |
| trades | 1 |

The D1 paper execution table is empty. Automatic paper trading is stored in the HyperliquidFeed Durable Object, not in D1. The KV namespace currently has 49 keys, including advisor scan cursors, Gemini key cursor, intraday pattern cache, Telegram runtime metadata, paper balance/circuit-breaker keys, and schema/index markers. Only key names were inspected; values were not exported.

The ONDO and ADA proposal records supplied in the conversation are present in the advisor lifecycle as expired proposals with no manual-entry/tracking timestamp. This does not mean their separate automatic paper trades were absent.

## GitLab recovery state

Repository: https://gitlab.com/leno3z4rrrri/ciel2

- Private repository; default branch `main`.
- `main` remains the recovered production baseline (latest inspected commit `753cc711`).
- `audit/paper-trading-fix` contains the isolated tier-aware staging patch, tests, audit documentation, and read-only checks.
- Latest audit-branch commit at this check: `650aaed3`.
- No merge request exists. The staging patch has not been merged into `main`.
- The recovered exact deployed bundle is 209,745 characters with SHA-256 `24e6452b4a2854a1e37f864adcb201d588771460eed68bcd100f5cfbafd564b6`.
- GitLab contains the compressed Cloudflare export fragments, recovered JavaScript module fragments, D1 schema migration, architecture notes, REA reports, and deterministic reassembly/patch/test scripts.
- This is an exact deployed-bundle reconstruction, not the original TypeScript project. Original TypeScript source maps/build provenance were not recovered.

### CI and live smoke

The first smoke-test run reached production and received HTTP 200 JSON from the root, health, markets, candles, and orderbook routes. It failed because the test incorrectly expected an `orderbook` or `bids` property; the actual API contract returns `snapshot`, `stale`, and `source`.

That assertion was corrected to check the documented `snapshot` field and boolean `stale` flag. The duplicate `live-readonly-smoke` job definition was removed from `.gitlab-ci.yml`, and syntax checking for the smoke script was added.

The subsequent read-only smoke job passed all 10 GET routes:
- `/`
- `/health`
- `/api/markets`
- `/api/candles?symbol=BTC&interval=15m`
- `/api/orderbook?symbol=BTC`
- `/api/positions`
- `/api/signals`
- `/api/research`
- `/api/intraday?symbol=BTC`
- `/api/alerts?limit=5`

All returned HTTP 200 and valid JSON. The health endpoint returned `ok: true`. The smoke test issued GET requests only and performed no state-changing actions.

The API-sourced pipeline associated with the smoke run reported an aggregate failed status even though all four listed jobs (recovery verification, LeverUp metadata verification, live smoke, and REA analysis) were successful. Two immediate push pipelines after the CI edits also reported failed aggregate statuses despite their listed required jobs succeeding and the smoke job remaining manual. The latest push pipeline, #76 at commit `650aaed3`, completed successfully; it reran `verify-ciel-recovery`. The REA analysis job also completed successfully on commit `a1f193f8`, and the 10-route live smoke job passed on pipeline #73. The duplicate job definition is now removed. Check the pipeline's final status again before merging.

## LeverUp Monad verification

The GitLab verifier queried the public pair API and the Monad mainnet contract directly:
- Chain ID: `143`
- Diamond: `0xea1b8E4aB7f14F7dCA68c5B214303B13078FC5ec`
- Pair API: `https://service.leverup.xyz/v1/pairs?size=100&block_chain=MONAD`
- Pair API reported 77 pairs.
- On-chain global minimum notional: **$20**.
- No missing watched pairs, contract errors, or Hyperliquid metadata errors.
- The patched staging leverage map has **zero mismatches** against the verified market metadata.
- The original map mismatches are BTC and ETH: it says 1001x, while the current on-chain contract reports 100x.

Verified maximum leverage for the 25-symbol watchlist:

| Market | Verified max leverage | Venue |
|---|---:|---|
| BTC | 100x | LeverUp pool |
| ETH | 100x | LeverUp pool |
| MON | 25x | LeverUp pool |
| BNB | 50x | LeverUp pool |
| XRP | 100x | LeverUp pool |
| HYPE | 50x | LeverUp pool |
| ONDO | 50x | LeverUp pool |
| KPEPE | 50x | LeverUp pool |
| QNT | 5x | LeverUp pool |
| ZEC | 25x | LeverUp pool |
| TRX | 50x | LeverUp pool |
| AAVE | 50x | LeverUp pool |
| ADA | 50x | LeverUp pool |
| CASHCAT | 3x | Hyperliquid |
| DOGE | 50x | LeverUp pool |
| LINK | 50x | LeverUp pool |
| LIT | 5x | LeverUp pool |
| PONS | 3x | Hyperliquid |
| PUMP | 50x | LeverUp pool |
| SEI | 50x | LeverUp pool |
| SOL | 100x | LeverUp pool |
| SUI | 50x | LeverUp pool |
| UNI | 50x | LeverUp pool |
| VIRTUAL | 50x | LeverUp pool |
| XMR | 25x | LeverUp pool |

This watchlist has no currently verified 1000x market. In particular, BTC and ETH are 100x on the contract, not 1001x.

### Minimum-margin interpretation

The $20 minimum notional explains the inverse relationship between leverage and required collateral. Before fees, safety buffers, and collateral discounts:

- 50x requires at least $20 / 50 = $0.40 effective margin.
- 100x requires at least $20 / 100 = $0.20 effective margin.
- 25x requires $0.80 effective margin.
- 10x requires $2.00 effective margin.
- 5x requires $4.00 effective margin.
- 2x requires $10.00 effective margin.

For MON collateral, the corresponding MON amount is:

`MON required = $20 / (leverage × live MON/USD price × live collateral ratio)`

Therefore, 22 MON at 50x and 11 MON at 100x are plausible conservative rounded thresholds at the observed MON price/discount conditions, but they are not immutable on-chain constants. LeverUp's own AnyCollateral documentation states that collateral ratios vary by asset and can change; the live ratio shown in the order panel must be used at trade time. The current verifier confirms minimum notional and market leverage, but does not yet fetch the live MON collateral ratio. Do not label the exact 22/11 MON amounts fully verified until that final input is queried.

The paper patch currently supports 50x with 22 MON and 100x+ with 11 MON only. It deliberately withholds 25x markets until their 180-second minimum-hold restriction is modeled; 5x and 3x markets exceed the 60 MON paper balance at the example MON price. The 10x and 2x amounts above are sizing calculations, not current watchlist maximum-leverage tiers. The patch also uses a conservative 100x simulation baseline for markets whose verified maximum is 100x. The patch tests cover tier entry, 22/11 MON margins, P&L, stop/target/max-hold/profit-protection closes, `/profits` reconciliation, entry guards, and Telegram copy.

## What is not cloned or verified yet

- Cloudflare does not return secret plaintext; fresh secrets must be entered in staging.
- Durable Object internal storage is not exportable through the current connection. The internal `_cf_KV` read is blocked with `SQLITE_AUTH`; the source paper ledger cannot be copied from the available interface.
- A full D1 data export was not started because it can temporarily make the live database unavailable. The schema and read-only counts are preserved, not the complete production dataset.
- R2 could not be inventoried because the R2 API was not enabled for this account.
- Live public API smoke covered 10 GET endpoints. Telegram callback actions, scheduled-cycle completion, full paper open/close lifecycle, persistence after a Durable Object restart, and a full target-account staging deployment remain to be tested.
- The source Worker has not been changed or redeployed.

## Next gates before connecting another account

1. Keep the current `leno3z4rrrri` Cloudflare connection intact.
2. Confirm the corrected audit-branch push pipeline finishes successfully.
3. Extend the LeverUp verifier to read the live MON collateral ratio and MON/USD oracle/market price, then compute the exact minimum MON for each leverage tier with an explicit safety buffer.
4. Preserve the source Durable Object paper-ledger limitation in the staging plan; staging starts with a fresh 60 MON paper balance.
5. Create a separate staging Worker with new D1/KV/SQLite DO namespaces and fresh Telegram credentials. Never overwrite the source bot webhook.
6. Test complete paper trade lifecycles and restart persistence in staging before any production deployment.


## Hyperliquid symbol and book identity diagnostics (2026-11-02)

The public Hyperliquid checks resolved the missing-book causes:
- KPEPE is named `kPEPE` in default `allMids` and `metaAndAssetCtxs`. The metadata universe contains the asset and context. `l2Book` works for exact coin `kPEPE` (bid 0.004892 / ask 0.004894 at the check) but returns HTTP 500 for uppercase `KPEPE`. Production normalizes the market symbol to uppercase and then requests the book using that uppercase value, so its REST fallback misses this book. The staging patch now preserves the original upstream coin name while keeping canonical uppercase CIEL symbols.
- QNT is absent from default `allMids` and from `metaAndAssetCtxs` for both default and `xyz`. The `allMids` request for DEX `xyz` does return `xyz:QNT` (34.186 at the check), and `l2Book` works for `xyz:QNT` (bid 34.111 / ask 34.261). But no derivatives context was returned for QNT in either metadata universe. The production Worker does not request the xyz DEX price or map this alias. QNT therefore remains excluded from advisor-ready market coverage until a valid funding/OI/mark/oracle context source is found; price/book alone is insufficient.

This makes the current production coverage gap precise: KPEPE's book is fixable with a case-preserving coin name (patched for staging); QNT is a separate DEX alias plus missing derivatives-context problem (not silently patched into a complete signal).
