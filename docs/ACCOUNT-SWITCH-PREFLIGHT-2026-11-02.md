# CIEL account-switch preflight — 2026-11-02

## Decision

**Do not connect the second Cloudflare account yet.** The source account is still connected and the production Worker is live. This checklist exists so the account switch is a deliberate step, not a blind one.

## What is preserved in GitLab

Branch: audit/paper-trading-fix

- Exact deployed-bundle reconstruction: 209,745 bytes, SHA-256 24e6452b4a2854a1e37f864adcb201d588771460eed68bcd100f5cfbafd564b6.
- Byte-exact recovered JavaScript fragments and export inputs.
- Recovered D1 schema: 16 application tables and 14 indexes; verified against live sqlite_master with no DDL differences.
- Staging wrangler.jsonc template with fresh-resource placeholders, not source account IDs.
- Staging config checker; it verifies that D1/KV/DO IDs are not copied from source and that DO migrations are SQLite-backed.
- Paper-tier patch, behavioral tests, REA output and LeverUp market-tier verification script.
- Source Worker version/deployment inventory, binding names, non-secret variables, D1/KV/DO resource IDs, current aggregate D1 snapshot and Telegram paper-report arithmetic.
- Live read-only smoke-test script and latest 14-route results.

The production Worker version 505 has not been modified. No Worker upload, deployment, secret change, binding change, D1 write, KV write or Durable Object write was performed by this audit.

## What is not exportable from the access available here

These items must not be described as backed up:

1. **Secret plaintext.** Cloudflare returns secret binding names, not their values. The source has seven Gemini key bindings and three Telegram secret bindings, but their plaintext cannot be read back.
2. **Full automatic paper ledger.** It is in the HyperliquidFeed Durable Object's internal storage key ciel:paper:account:v1, not D1. Cloudflare's exposed DO SQL query interface rejected the internal KV table with an authorization error. The user's supplied /profits snapshot and trade examples are documented, but the complete 20-trade history was not exported.
3. **Full D1 row data.** The schema and aggregate counts are preserved; the full 35 MB database contents were not exported. No D1 export was started because that can affect database availability and is unnecessary for a fresh paper-trading staging account.
4. **KV runtime values.** Key names were inventoried. Sensitive runtime values were not copied. The Telegram auto-registration marker includes a secret-derived fingerprint and was not written into GitLab.
5. **Live LeverUp credentials.** None are bound to the source Worker. CIEL is advisory-only and does not place LeverUp orders.

The source account and its data remain in Cloudflare. Losing the ChatGPT connector link would remove assistant access, not delete the Cloudflare resources.

## Critical Telegram separation rule

**The staging Worker must use a different Telegram bot token from production.**

The production scheduled handler calls ensureTelegramWebhook every minute. That routine registers its bot's webhook URL with Telegram. A second Worker using the same bot token would overwrite the same Telegram webhook; the two Workers could fight over webhook registration and callbacks would be routed unpredictably.

For staging:
- Create a separate Telegram bot with BotFather.
- Use a separate staging chat ID and webhook secret.
- Do not copy the production bot token or webhook secret.
- Do not configure the staging Telegram secrets until the separate bot exists.

Use a separate Gemini API key for staging if possible. Reusing all seven production Gemini keys could increase quota pressure while both Workers are running.

## Staging target

The template is designed for a clean, separate deployment:

- New Worker named ciel in the second Cloudflare account.
- New D1 database; apply the recovered schema migrations.
- New KV namespace.
- New SQLite-backed Durable Object namespaces for HyperliquidFeed and TradingEngine.
- New secrets entered directly in Cloudflare's secret UI; never paste secrets into ChatGPT or commit them to GitLab.
- Fresh paper ledger, defaulting to 60 MON.
- Paper-only/advisory-only operation. No LeverUp order credentials or execution path.
- Separate Telegram bot for staging notifications and commands.
- No source-account resource IDs copied into the staging template.

The new paper ledger will start fresh. It will not inherit the source account's current 60 MON balance, open AAVE position, closed-trade history or realised P&L.

## Remaining staging gates

- Resolve the feed coverage gap: current Hyperliquid feed returns 25 watchlist entries but only 24 have prices; QNT is missing a price and order book. KPEPE has a price but is also missing an order book. The live feed reports 23/25 books. The five sampled core books (BTC, ETH, MON, ONDO, ADA) were fresh on the latest 14-route smoke test.
- Confirm current MON collateral ratio in LeverUp's order panel. At the latest Hyperliquid MON reference of $0.019038, 22 MON at 50x and 11 MON at 100x each imply about $20.94 notional at 100% CR; they clear a $20 minimum only if CR is at least about 95.5%. CR is dynamic and was not read from the live order panel.
- Keep 25x/5x/3x paper tiers disabled until minimum-hold and collateral rules are simulated. Current verified 25x and 5x markets have 180-second minimum-hold restrictions; 5x/3x are also beyond a 60 MON paper balance at current prices.
- Test DO paper-ledger persistence across restart on staging, not on the production DO.
- Test Telegram callback buttons using the separate staging bot.
- Monitor D1 write usage on staging; exact source-account daily usage telemetry was not exposed.
- Continue investigating expired advisor proposals. Latest D1 totals were 225 expired of 234; this does not alone prove a callback failure.

## Safe account-switch sequence

1. Keep the current leno3z4rrrri@gmail.com Cloudflare connection intact until ready.
2. Decide whether the source paper ledger needs a full manual preservation attempt. If yes, do not switch yet; that requires a separate, carefully scoped export approach.
3. Create the separate staging Telegram bot and a separate Gemini key.
4. Only then connect the second Cloudflare account, accepting that the ChatGPT connector may replace the current account link.
5. Create new staging resources from the template and replace only its placeholders.
6. Deploy the patched staging Worker to the second account, not the source account.
7. Verify health, feed coverage, Telegram commands/callbacks, automatic paper open/close, /profits, DO persistence and D1 usage.
8. Keep source Worker version 505 running until the staging run is proven.

**Current state:** source account remains connected; no second account has been connected; no staging deployment has been made.


## Hyperliquid symbol and book identity diagnostics (2026-11-02)

The public Hyperliquid checks resolved the missing-book causes:
- KPEPE is named `kPEPE` in default `allMids` and `metaAndAssetCtxs`. The metadata universe contains the asset and context. `l2Book` works for exact coin `kPEPE` (bid 0.004892 / ask 0.004894 at the check) but returns HTTP 500 for uppercase `KPEPE`. Production normalizes the market symbol to uppercase and then requests the book using that uppercase value, so its REST fallback misses this book. The staging patch now preserves the original upstream coin name while keeping canonical uppercase CIEL symbols.
- QNT is absent from default `allMids` and from `metaAndAssetCtxs` for both default and `xyz`. The `allMids` request for DEX `xyz` does return `xyz:QNT` (34.186 at the check), and `l2Book` works for `xyz:QNT` (bid 34.111 / ask 34.261). But no derivatives context was returned for QNT in either metadata universe. The production Worker does not request the xyz DEX price or map this alias. QNT therefore remains excluded from advisor-ready market coverage until a valid funding/OI/mark/oracle context source is found; price/book alone is insufficient.

This makes the current production coverage gap precise: KPEPE's book is fixable with a case-preserving coin name (patched for staging); QNT is a separate DEX alias plus missing derivatives-context problem (not silently patched into a complete signal).
