# CIEL staging remediation — 2026-11-02

## Code fixes in this commit

- QNT uses the verified Hyperliquid xyz:QNT allMids and L2-book alias. It is monitor-only: no derivatives context is available and its verified 5x tier is not eligible for paper entry.
- KPEPE continues to use the exact upstream coin name (kPEPE) for book requests.
- Staging Telegram auto-registration no longer contains the production Worker URL. It requires an HTTPS staging webhook URL and a TELEGRAM_STAGING_BOT_ID matching Telegram getMe.
- Added read-only /api/paper and /api/diagnostics routes. Diagnostics report D1 schema/table coverage, market-history row ranges, Gemini-key count, Telegram-secret presence, webhook-marker presence, feed status and paper-ledger aggregates. No secret values are returned.
- Added a one-time, idempotent four-day native 5m candle bootstrap for BTC/ETH/MON using bounded D1 batches. It seeds intraday sample rows and hourly summaries without writing every live tick to D1.
- Enforced 5% per-trade and 10% combined stop-risk caps inside the paper-ledger transaction.
- Expanded staging smoke coverage for paper status, D1 schema, QNT monitor-only handling, 15m candle history and intraday history.
- Main-branch CI runs the staging-only smoke test; the script refuses any host other than ciel2.gatakehanami.workers.dev.

## External configuration still required

The primary Cloudflare account is not connected in this session and account switching is prohibited. No secrets were read, copied or changed. Staging Telegram still requires a separate bot token, chat ID, webhook secret and numeric bot ID. The webhook URL is https://ciel2.gatakehanami.workers.dev/telegram/webhook.

Gemini review requires at least one of GEMINI_API_KEY_1 through GEMINI_API_KEY_7. Diagnostics reports the configured count without exposing values.

## Validation gates

GitLab CI validates exact-bundle reconstruction, paper risk limits, market metadata and staging config. The main-branch staging smoke validates the deployed Worker. No LeverUp orders are sent; CIEL remains advisory plus paper-only.