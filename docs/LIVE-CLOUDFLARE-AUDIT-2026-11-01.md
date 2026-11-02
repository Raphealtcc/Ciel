# CIEL live Cloudflare and repository audit — 2026-11-02

## Decision

**Do not switch the Cloudflare connection or deploy to the source account yet.** The connected source account is still accessible and has not been modified. The complete account handoff is recorded in `docs/HANDOFF-2026-11-02.md`.

The recovered production baseline is byte-exact. The leverage-tier patch remains isolated on `audit/paper-trading-fix`. No Worker upload, deployment, binding mutation, secret rotation, D1 write, KV write, or Durable Object write was performed.

## 1. Cloudflare account and live Worker

- Account profile: `leno3z4rrrri@gmail.com`
- Account ID: `479908018ec0f3099f920b1a7751aadb`
- Workers.dev subdomain: `leno3z4rrrri`
- Custom Worker domains: none.

Live Worker:
- Script: `ciel`
- URL: `https://ciel.leno3z4rrrri.workers.dev`
- Version: `505`
- Version ID: `2c5ea0a1-1608-4f79-9013-86ddcac0c42a`
- Deployment ID: `431af2ec-8ce0-49c3-a222-b1c3a683af41`
- 100% deployment allocation on version 505.
- Created: `2026-10-31T17:34:05.625841Z`
- Handlers: `fetch`, `scheduled`
- Cron: `* * * * *`
- Compatibility date: `2026-09-08`, flag `nodejs_compat`
- Usage model: `standard`
- Cloudflare reports migration tag `v2`.

The account also contains a separate `ciel-audit-probe-20261101` script with no bindings, no cron schedule and no custom route/domain. It was left untouched. There are two D1 databases and two KV namespaces in the account; the `infotrader_state` database and `infotrader-state` KV namespace are legacy separate-app resources, not CIEL staging resources.

## 2. Live bindings and credentials

| Binding | Type | Source resource |
|---|---|---|
| `DB` | D1 | `fb55e85b-af9b-45b3-ba43-6c7f7996dfa8` |
| `CIEL_STATE` | KV | `8b5c4b6078ce43a8aec4d9343855a70f` |
| `HYPERLIQUID_FEED` | Durable Object | `HyperliquidFeed`, namespace `23b7406149df46e1b737473441be73ca` |
| `TRADING_ENGINE` | Durable Object | `TradingEngine`, namespace `116d1ec659a640c297efdf3326a4a90c` |

Both Durable Object namespaces report `use_sqlite: true`. The feed namespace has one stored object with data. The retired `TradingEngine` namespace has zero objects.

Secret bindings present by name:
- `GEMINI_API_KEY_1` through `GEMINI_API_KEY_7`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `TELEGRAM_WEBHOOK_SECRET`

Cloudflare does not return plaintext secret values. No values were copied, exposed or changed. No LeverUp API credential binding is present.

## 3. Configuration drift

Live plain-text values observed:
- `ADVISORY_COLLATERAL_MON=10`
- `ADVISORY_LEVERAGE=100`
- `ADVISORY_MAX_HOLD_MINUTES=90`
- `ADVISORY_MIN_CONFIDENCE=0.72`
- `ALERT_COOLDOWN_MINUTES=15`
- `ALERT_WINDOW_MINUTES=5`
- `GEMINI_MODEL=gemini-3.5-flash-lite`
- `GEMINI_REVIEW_COOLDOWN_MINUTES=15`
- `MOVE_ALERT_PCT=2.0`
- `WATCH_SYMBOLS`: 25 symbols (BTC, ETH, MON, BNB, XRP, HYPE, ONDO, KPEPE, QNT, ZEC, TRX, AAVE, ADA, CASHCAT, DOGE, LINK, LIT, PONS, PUMP, SEI, SOL, SUI, UNI, VIRTUAL, XMR).

A search across all recovered JavaScript modules confirms:
- `ADVISORY_MIN_CONFIDENCE`, `ALERT_COOLDOWN_MINUTES`, `ALERT_WINDOW_MINUTES`, `GEMINI_MODEL`, `MOVE_ALERT_PCT`, and `WATCH_SYMBOLS` are read by code.
- `ADVISORY_COLLATERAL_MON`, `ADVISORY_LEVERAGE`, `ADVISORY_MAX_HOLD_MINUTES`, and `GEMINI_REVIEW_COOLDOWN_MINUTES` are not referenced by the deployed bundle. They are stale settings, not active controls.
- Trend-review cooldown is controlled by `ADVISORY_TREND_REVIEW_COOLDOWN_MINUTES`, default 30 minutes; this variable is not set in the source Worker.
- The current proposal/paper path uses the code's 22 MON / 50x constants, not the stale 10 MON / 100x variables.
- The paper trend-hold duration defaults to 180 minutes in the proposal path; `ADVISORY_MAX_HOLD_MINUTES=90` does not override it.

The staging `wrangler.jsonc` now omits stale variables and explicitly sets the active 30-minute trend cooldown. It uses target-account placeholder IDs, not source-account IDs.

## 4. D1 inventory and latest read-only observations

D1 database:
- Name: `ciel`
- ID: `fb55e85b-af9b-45b3-ba43-6c7f7996dfa8`
- Size at latest query: 35,086,336 bytes.
- 16 application tables, plus internal SQLite/Cloudflare tables.
- The repository contains a recovered schema, not a database-data backup.

Application table row counts:

| Table | Rows |
|---|---:|
| `advisor_ai_audit` | 944 |
| `advisor_positions` | 234 |
| `live_executions` | 1 |
| `live_positions` | 1 |
| `market_alerts` | 67 |
| `market_book_snapshots` | 6,634 |
| `market_candle_hourly_stats` | 2,456 |
| `market_candles` | 20,104 |
| `market_context_snapshots` | 44,261 |
| `market_samples` | 96,095 |
| `market_snapshots` | 63,226 |
| `paper_executions` | 0 |
| `positions` | 0 |
| `signals` | 1 |
| `tokens` | 191 |
| `trades` | 1 |

Advisor AI audit verdict counts:
- `APPROVE`: 113
- `REJECT`: 41
- `WAIT`: 790

Advisor position statuses:
- `EXPIRED`: 225
- `CLOSING`: 4
- `CLOSED`: 2
- `CANCELLED`: 3

This means there are no currently `PROPOSED` or `OPEN` rows in the advisor-position table at the time of this query. Most recommendations expire rather than becoming manually tracked positions. This is a funnel/notification/callback issue to investigate; it is not the same thing as automatic paper trade performance.

Recent stored market-data timestamps:
- `market_samples`: `2026-11-02T00:31:22.110Z`
- `market_candles`: `2026-11-02T00:25:00.000Z`
- `market_context_snapshots`: `2026-11-02T00:16:15.552Z`
- `market_book_snapshots`: `2026-10-28T22:59:25.064Z`
- `market_alerts`: `2026-10-31T20:14:15.656Z`

The old `market_book_snapshots` table is no longer persisted by the current feed code; it explicitly avoids high-volume D1 book writes. Live order-book state is maintained in the feed Durable Object and recent advisor audit records contain spread/depth values. Do not treat that old D1 table timestamp as the current live order-book timestamp.

The `trades`, `live_executions`, `live_positions`, `tokens`, `signals` and related tables are legacy token-trader data. They are not the current perp paper ledger. Do not mix their records into CIEL perp results.

## 5. User-provided Telegram examples cross-checked against live D1

The supplied ONDO signal `E35323EDFE` and ADA signal `762352AACB` both exist in D1 and both have status `EXPIRED`, with no manual-entry or tracking timestamp. This is consistent with the messages: pressing START TRACKING controls the separate real-position ledger. The automatic paper trader opens independently.

The automatic paper ledger is stored in the `HyperliquidFeed` Durable Object under `ciel:paper:account:v1`, not in D1 `paper_executions`. D1 `paper_executions` currently has zero rows; that does not contradict the Telegram output.

The user-supplied `/profits` snapshot is arithmetically consistent:
- 38.745 MON available + 22 MON reserved = 60.745 MON before unrealised P&L.
- +0.745 MON realised − 3.518 MON unrealised = −2.773 MON total P&L.
- 60 MON starter balance − 2.773 MON = 57.227 MON equity.

The sample AAVE short's mark movement also agrees with a 50x gross mark-to-market calculation. A 0.4% adverse move at 50x corresponds to about 20% of the 22 MON margin, or roughly 4.4 MON loss. The paper ledger is performing real stateful arithmetic; it is not a static sample balance.

### What the paper simulator actually does

- Fresh paper state starts with 60 MON.
- Production baseline uses 22 MON margin and 50x leverage.
- A qualifying setup automatically attempts a paper entry.
- Paper trade state is stored in Durable Object KV storage.
- Stop, target, profit-protection and max-hold exits are evaluated against Hyperliquid mids.
- P&L is converted to MON using the entry MON/USD price for notional and current MON/USD price at exit.
- Stop/target exits book at the configured threshold; profit-protection and max-hold book at the observed current mid.
- The paper engine caps a loss at reserved margin.

This is a **gross mark-based strategy simulation**, not a faithful LeverUp execution simulator. It does not model fees, funding, executable bid/ask, spread, slippage, gap-through fills, LeverUp collateral ratio, mark/oracle differences or liquidation mechanics.

## 6. Confirmed paper-tier defect and staging patch

Original helper:
- max leverage 50 → 22 MON
- max leverage >=100 → 11 MON
- other tiers → unsupported

But original `openPaperTrade()` rejected all markets except max leverage exactly 50, and `runAdvisorCycle()` scanned only max-50x markets. The 11 MON / >=100x branch was unreachable.

The isolated patch on `audit/paper-trading-fix` now:
- allows supported 50x and >=100x market tiers;
- uses 22 MON for 50x and 11 MON for >=100x;
- simulates markets with max leverage >=100x at a conservative 100x baseline; BTC/ETH are corrected from the recovered 1001x value to the verified 100x;
- removes the paper-cash early return that previously stopped all advisor recommendations when paper balance fell below 22 MON; each automatic paper entry now independently checks its tier margin and available balance;
- stores the same tier-specific margin/leverage in the advisor proposal record;
- updates the setup card, paper-open notification, `/help`, and `/profits` copy so displayed and actual paper tiers agree.

The source map remains hardcoded as forensic source, but a live verification script now checks all 25 watchlist entries against LeverUp pair API + Monad Diamond `getPairByBaseV4` (23 pool markets) or Hyperliquid public metadata (2 markets). It found only two source-map mismatches (BTC/ETH 1001x vs 100x); the staging map has zero mismatches. The $20 global minimum notional is verified. Exact MON collateral amounts still depend on live MON CR and order-panel rounding; see `docs/LEVERUP-MARKET-TIER-AUDIT-2026-11-02.md`.

The byte-exact recovered fragments remain unchanged. `scripts/apply-paper-tier-fix.mjs` writes only `reconstructed/patched-worker.js`.

## 7. Test and REA status

Behavioral tests extract the actual patched functions and test:
- 50x / 22 MON and >=100x / 11 MON entry tiers;
- conservative 100x baseline for max-1001 markets;
- unsupported 25x/5x tiers;
- insufficient balance, duplicate signal and one-open-trade-per-symbol guards;
- 50x and 100x P&L calculations;
- stop-loss, take-profit and max-hold closes;
- profit-protection giveback confirmation;
- `/profits` equity reconciliation;
- tier-consistent Telegram setup, open and help copy.

The latest passing behavioral verification before the current CI update is GitLab pipeline `3015613308` / job `17649637022`. The current CI job is being updated to run REA on the patched candidate and is in progress at the time of this report.

REA on the recovered production bundle completed:
- 7 JavaScript files parsed
- 66,209 AST nodes visited
- 216 findings
- 0 parse failures
- 134 application graph nodes, 230 edges
- route inventory coverage: unknown

REA is static analysis. Its route inventory is not an HTTP route test and does not prove runtime behavior.

## 8. Endpoint and telemetry limitations

The recovered request handler contains:
- GET `/`, `/health`, `/api/markets`, `/api/candles`, `/api/orderbook`, `/api/positions`, `/api/signals`, `/api/research`, `/api/intraday`, `/api/alerts`
- POST `/telegram/webhook`, `/telegram/register-webhook`

The Cloudflare API verified script settings, deployment allocation, bindings, schedules, resource IDs and version metadata. Direct fetches from this execution environment to the public `workers.dev` hostname were blocked by a 403 network policy. Therefore no fresh HTTP endpoint smoke test is claimed. Prior same-day snapshots remain point-in-time evidence only.

Cloudflare Observability key discovery succeeded, but the available telemetry query returned zero event rows and the usage endpoint returned zero. This is not evidence of zero traffic; those endpoints did not provide usable request/log data in this audit.

## 9. Staging-account safety and remaining work

The updated `wrangler.jsonc` is a new-account template:
- Worker name `ciel-paper-staging`
- D1/KV IDs are placeholders and must be replaced with target-account IDs.
- DO migration uses `new_sqlite_classes`, matching the source namespaces' SQLite backend.
- Fresh target migration tag is `v1`; do not copy the source Worker `v2` tag blindly.

Before staging:
1. Create a target D1 database and KV namespace, then replace the placeholders.
2. Apply the reviewed recovered D1 schema.
3. Configure new Gemini and Telegram secrets. Use a separate Telegram bot for staging so its webhook cannot replace the live bot's webhook.
4. Keep LeverUp credentials absent; staging remains advisory/paper-only.
5. Test health, all routes, Telegram webhook/buttons, paper open/close lifecycle, DO persistence after restart, feed reconnects, D1 write volume and current LeverUp market limits.
6. Investigate the 224 expired recommendations and verify notification/callback handling.
7. Add realistic execution-cost and liquidation assumptions before treating paper results as LeverUp performance.

A D1 full export was not initiated because Cloudflare warns that an in-progress export may make the live database unavailable while the export is running. The recovered schema is available in GitLab; D1 data and the protected Durable Object ledger are not copied.

## Final decision

The source account is sufficiently inventoried to prepare a separate staging deployment without losing the code/configuration record. The source Worker remains unchanged. The paper-tier patch has passed deterministic behavior tests, but it is not production-ready until patched-bundle REA, fresh endpoint smoke tests, authoritative LeverUp metadata, DO restart/persistence tests and realistic execution modeling are complete.


## 10. Fresh live HTTP, Telegram, schema and D1-write checks

A manual GitLab CI read-only smoke test reached the public Worker. All 10 GET routes returned HTTP 200 and valid JSON: `/`, `/health`, `/api/markets`, `/api/candles`, `/api/orderbook`, `/api/positions`, `/api/signals`, `/api/research`, `/api/intraday`, and `/api/alerts`. `/health` returned `ok: true`. No POST or state-changing endpoint was called.

The Telegram auto-registration marker exists in KV. Code inspection confirms the scheduled handler calls `ensureTelegramWebhook`; the marker is written only after successful `setWebhook` and `getWebhookInfo` verification of both `message` and `callback_query` updates. The webhook handler validates Telegram's secret header and the configured chat ID. This is last-known successful registration evidence, not a fresh Telegram API query or a live button-click test.

The live D1 schema was compared with GitLab's recovered migration: 16 application tables and 14 indexes match exactly, with no missing/extra names or DDL differences. Internal `_cf_KV` is intentionally excluded. All D1 audit queries were read-only and reported zero rows written.

The feed's write path keeps full one-minute analysis history in Durable Object storage; D1 receives benchmark samples each minute and wider-watchlist samples every six minutes, plus batched context/candle snapshots and slower hourly summaries. Per-tick order-book snapshots are no longer written to D1. Exact D1 daily usage totals remain unavailable from the exposed analytics endpoints.

## 11. Current advisor activity

Latest D1 counts: 944 AI decisions (113 APPROVE, 41 REJECT, 790 WAIT); 234 advisor positions (225 EXPIRED, 4 CLOSING, 2 CLOSED, 3 CANCELLED). 24/25 watchlist symbols have current sample history; QNT is missing. Recent WAIT reasons include missing fresh funding/OI or order-book evidence, insufficient depth, forecast magnitude below the stop-distance requirement, RSI exhaustion, and one Gemini-unavailable fallback. The two sample signal IDs remain expired and have no manual-entry/tracking timestamps.

The webhook registration marker and callback code are present, but no actual Telegram button-click test was performed. Expired recommendations therefore cannot be attributed to a broken callback without further evidence.

## 12. CI status anomaly

The latest jobs individually report success for exact-bundle recovery and behavior tests, LeverUp market metadata verification, REA analysis, and the 10-route live smoke test. GitLab's pipeline-level API status nevertheless reports `failed` while its job list shows every job as successful and no failed/cancelled jobs or bridges. This inconsistency remains unexplained. Do not call the pipeline green or merge based on the job statuses alone; inspect the GitLab pipeline UI.


### Additional checks completed 2026-11-02

- Live HTTP smoke test: all 10 GET routes passed (root, health, markets, candles, orderbook, positions, signals, research, intraday, alerts).
- Live D1 schema comparison: 16 application tables and 14 indexes exactly match `migrations/0000_recovered_live_schema.sql`; no missing/extra names or DDL differences.
- Telegram: KV auto-registration marker exists. Source code writes it only after successful `setWebhook` and `getWebhookInfo` verification of `message` and `callback_query`; the webhook handler validates the Telegram secret header and chat ID. This is last-known registration proof, not a live button-click test.
- Current D1 row counts and latest timestamps are recorded in the handoff. All audit queries were read-only and returned `rows_written=0`.
- The latest pipeline's individual jobs all show success, but GitLab's top-level pipeline status reports `failed` with no failed/cancelled jobs or bridges listed. This anomaly remains unresolved; do not call the pipeline green.
