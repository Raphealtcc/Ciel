# CIEL live-vs-recovery audit — 2026-11-01

## Scope and safety

Audit performed against Cloudflare account profile `leno3z4rrrri@gmail.com` only. Account ID: `479908018ec0f3099f920b1a7751aadb`. The primary Cloudflare profile was not used.

No Worker upload, deployment, binding mutation, secret rotation, D1 write, KV write, or Durable Object write was performed during this audit. Production Worker remains untouched.

## Live Worker identity and deployment

- Script: `ciel`
- Latest version: `505`
- Version ID: `2c5ea0a1-1608-4f79-9013-86ddcac0c42a`
- Created: `2026-10-31T17:34:05.625841Z`
- Deployment ID: `431af2ec-8ce0-49c3-a222-b1c3a683af41`
- Deployment allocation: 100% on version 505
- Handlers: `fetch`, `scheduled`
- Durable Object classes: `HyperliquidFeed`, `TradingEngine`
- Cron: `* * * * *`
- Compatibility date: `2026-09-08`, flag `nodejs_compat`
- Usage model: `standard`

The live Worker settings, version metadata, deployment allocation, bindings and cron were read from Cloudflare's API. The version and deployment agree with the recovered bundle inventory. Earlier same-day read-only endpoint snapshots recorded HTTP 200 for `/health`, `/api/signals`, and `/api/research`, but those snapshots are point-in-time evidence, not a fresh endpoint smoke test.

## Live configuration inventory

Non-secret values observed:
- `ADVISORY_COLLATERAL_MON=10`
- `ADVISORY_LEVERAGE=100`
- `ADVISORY_MAX_HOLD_MINUTES=90`
- `ADVISORY_MIN_CONFIDENCE=0.72`
- `ALERT_COOLDOWN_MINUTES=15`
- `ALERT_WINDOW_MINUTES=5`
- `GEMINI_MODEL=gemini-3.5-flash-lite`
- `GEMINI_REVIEW_COOLDOWN_MINUTES=15`
- `MOVE_ALERT_PCT=2.0`
- Watchlist: 25 symbols (BTC, ETH, MON, BNB, XRP, HYPE, ONDO, KPEPE, QNT, ZEC, TRX, AAVE, ADA, CASHCAT, DOGE, LINK, LIT, PONS, PUMP, SEI, SOL, SUI, UNI, VIRTUAL, XMR)

Bindings:
- D1 `DB` → `fb55e85b-af9b-45b3-ba43-6c7f7996dfa8`
- KV `CIEL_STATE` → `8b5c4b6078ce43a8aec4d9343855a70f`
- Durable Object `HYPERLIQUID_FEED` → `23b7406149df46e1b737473441be73ca`, class `HyperliquidFeed`
- Durable Object `TRADING_ENGINE` → `116d1ec659a640c297efdf3326a4a90c`, class `TradingEngine`

Secret bindings already exist by name: `GEMINI_API_KEY_1` through `GEMINI_API_KEY_7`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET`. Cloudflare does not return plaintext secret values from the secret-list API. No secret values were copied, exposed or changed. No LeverUp API credential binding is present.

## Execution mode: paper vs live

The recovered code identifies the service as read-only advisory. The retired `TradingEngine` Durable Object responds HTTP 410 with a read-only/retired message. The active advisor does not submit orders to LeverUp or Hyperliquid. This is consistent with the user's requirement to keep all activity in paper mode until LeverUp integration is ready.

The paper engine is a separate automatic simulation:
- Fresh paper ledger defaults to 60 MON.
- Original constants are 22 MON paper margin and 50x paper leverage.
- A qualifying proposal attempts an automatic paper entry.
- Paper ledger is held in Durable Object storage under `ciel:paper:account:v1`, not in the D1 trading tables.
- `/profits` reads the paper ledger and reports balance, open/closed trades, realised/unrealised P&L, wins/losses, and strategy stats.
- Paper exits are estimated from Hyperliquid mid prices at stop, target, or max-hold time.
- Paper P&L excludes fees, funding, slippage, liquidation mechanics and LeverUp-specific mark/oracle/fill differences. It is not a faithful execution simulator and should not yet be used as evidence of LeverUp profitability.

Important configuration distinction: live advisory display variables say 10 MON / 100x, while the original paper engine hardcodes 22 MON / 50x. These are separate paths. Do not assume the original paper P&L corresponds to the displayed 10 MON / 100x scenario.

## Confirmed paper trading bug and isolated fix

The original code contains `minimumMarginForMarketLeverage()`:
- max leverage 50 → 22 MON
- max leverage >=100 → 11 MON
- otherwise → unsupported

But two additional gates contradicted that helper:
1. `openPaperTrade()` rejected any market unless its max leverage was exactly 50.
2. `runAdvisorCycle()` scanned only markets whose max leverage was exactly 50.

Therefore the 11 MON / >=100x branch was unreachable. BTC, ETH, XRP and SOL (as currently represented in the static map) were excluded from automatic paper scanning even though the helper advertised a 100x+ margin tier.

An isolated patch was added on branch `audit/paper-trading-fix`:
- Allows paper entries for supported 50x and >=100x tiers.
- Uses 22 MON for 50x and 11 MON for >=100x.
- Uses a conservative 100x simulation baseline for markets whose maximum leverage is >=100x (it does not automatically simulate at each market's maximum).
- Makes the scanner's cash gate tier-aware.
- Makes the entry notification show the actual margin and leverage.
- Labels the `/profits` summary as leverage-tiered.

The byte-exact `recovered-src/` files remain unchanged. `scripts/apply-paper-tier-fix.mjs` applies the patch only to `reconstructed/patched-worker.js`, preserving `reconstructed/worker.js` as the exact deployed bundle.

GitLab pipeline `3014296834` verified the exact recovery hash and syntax-checked both the recovered Worker and patched staging candidate. The paper patch is syntax-validated, not yet behaviorally unit-tested or deployed.

The market leverage map remains hardcoded in `recovered-src/symbols.js.part-001`; it must not be treated as verified live LeverUp market metadata. The user's reported minimums still need authoritative market metadata verification before matching the simulator to LeverUp.

## Endpoint verification status

Recovered route table includes:
- GET `/`, `/health`, `/api/markets`, `/api/candles`, `/api/orderbook`, `/api/positions`, `/api/signals`, `/api/research`, `/api/intraday`, `/api/alerts`
- POST `/telegram/webhook`, `/telegram/register-webhook`

The Cloudflare account API was able to verify the Worker configuration and deployment. The available execution environment blocked direct fetch requests to the public `workers.dev` hostname (403 policy block), and the web fetcher could not retrieve the endpoint URLs. Thus a fresh live HTTP smoke test of those public endpoints is not claimed here. Prior same-day snapshots remain recorded in `docs/live-runtime-snapshot-2026-11-01.md`.

Cloudflare Observability key discovery succeeded, but the two-hour Workers dataset event query returned zero events and the 24-hour usage endpoint also returned zero. This is not proof the Worker received no traffic; it means those telemetry endpoints did not provide usable request/log evidence for this audit.

## Credentials and account access

Cloudflare's secret list confirms that seven Gemini key slots and three Telegram secret bindings already exist. Secret values cannot be read back through Cloudflare's API, by design. Therefore they cannot be safely copied into GitLab CI variables from this session. They remain configured on the source Worker. No credentials were written to the repository. There are no LeverUp API credentials configured in the Worker.

## Required fixes before any deployment

1. Keep the byte-exact recovered fragments immutable as forensic evidence.
2. Add deterministic behavior tests for 50x, >=100x, unsupported <50x, insufficient balance, duplicate signal, one-open-trade-per-symbol, and P&L calculations.
3. Verify market max leverage and minimum collateral against authoritative LeverUp market metadata before using the static map for real integration.
4. Freshly smoke-test every GET route, Telegram webhook and callbacks. The current tool environment cannot reach the public Worker hostname directly.
5. Test paper open/close lifecycle, DO persistence across restarts, feed reconnects, and D1 write volume on a separate staging Worker.
6. Compare paper P&L with realistic fees, funding, slippage, mark/oracle and liquidation assumptions before interpreting strategy profitability.
7. Only then consider production cutover. Do not disable or overwrite the existing source Worker during reconstruction.

## Decision

**Production audit is not yet passed for deployment.** The recovered source matches the live version inventory and the paper-tier code fix has a syntax-checked staging candidate. However, behavioral tests, fresh live endpoint smoke tests, and authoritative LeverUp market metadata checks remain outstanding. The production Worker was not modified.
