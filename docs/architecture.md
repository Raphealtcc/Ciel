# CIEL recovered architecture

**Evidence date:** 2026-11-01  
**Primary evidence:** deployed Cloudflare Worker bundle, Worker settings/version 505, and live D1 schema.  
**Confidence:** high for code paths present in the deployed bundle; lower for historical source structure, original build tooling, and omitted source maps.

## What this system currently is

The deployed Worker identifies itself as **Ciel Hyperliquid Market Advisor** and explicitly reports `read-only-advisory` mode. It consumes Hyperliquid all-mids, candle and order-book feeds through a Durable Object and produces advisory signals/position tracking. It does not submit trades to LeverUp or Hyperliquid from the inspected Worker.

The current deployed bundle is version **505**, created 2026-10-31 17:34:05 UTC. It has `fetch` and `scheduled` handlers and named Durable Object classes `HyperliquidFeed` and `TradingEngine`. The `TradingEngine` class is deliberately retired: its `fetch()` returns HTTP 410 with “Legacy trading runtime retired. Ciel is read-only on this version.”

## Recovered module boundaries

The deployed bundle preserved six esbuild source markers. The JavaScript emitted for each marker is stored in `recovered-src/` as ordered chunks.

| Original marker | Recovered section | Approx. characters |
|---|---|---:|
| `src/symbols.ts` | `symbols.js` | 1,647 |
| `src/cloudflare-forecast.ts` | `cloudflare-forecast.js` | 4,425 |
| `src/advisor.ts` | `advisor.js` | 118,790 |
| `src/telegram.ts` | `telegram.js` | 11,954 |
| `src/hyperliquid_feed.ts` | `hyperliquid_feed.js` | 46,516 |
| `src/index.ts` | `index.js` | 26,022 |

The original TypeScript source map was referenced by `//# sourceMappingURL=index.js.map`, but Cloudflare's content export contained only `index.js`. Therefore these are emitted JavaScript sections, not recovered original TypeScript. Reassembly restores the deployed bundle's code layout; it does not restore erased type annotations, original import declarations, package scripts, test files, or Git history.

Run `npm run check` from `ciel/` to reassemble and run Node's syntax check. Do not deploy before the staging checklist below is complete.

## Request surface recovered from `src/index.ts`

All ordinary API endpoints are GET-only. Telegram webhook registration is POST-only.

| Method | Path | Observed behavior |
|---|---|---|
| GET | `/` | Service identity, read-only mode, feed description and advertised endpoints |
| GET | `/health` | Checks feed response, WebSocket connection and last tick age; healthy only if connected and tick is less than 120 seconds old; returns 503 otherwise |
| GET | `/api/markets` | Live feed/market summary; also contains hourly summary state logic |
| GET | `/api/candles` | Candle/history query; parameters: symbol (default BTC), interval (1m/5m/15m/1h), limit (1–500, default 100) |
| GET | `/api/orderbook` | Latest in-memory Durable Object order-book snapshot; stale after 180 seconds; intentionally avoids duplicate D1 writes |
| GET | `/api/positions` | Tracked advisory positions with live mark prices; refuses current P&L if feed is stale |
| GET | `/api/signals` | Same position data filtered to PROPOSED, OPEN and EXIT_ALERTED |
| GET | `/api/research` | Latest 25 Gemini audit rows, Gemini cooldown and event-intelligence state |
| GET | `/api/intraday` | Intraday pattern analysis for a symbol using fresh Hyperliquid price and stored hourly history |
| GET | `/api/alerts` | Recent market alerts; limit parameter clamped to 1–100, default 50 |
| POST | `/telegram/webhook` | Telegram messages and callback queries; delegates to Telegram webhook handler |
| POST | `/telegram/register-webhook` | Protected by `Authorization: Bearer <TELEGRAM_WEBHOOK_SECRET>`; registers webhook and verifies Telegram webhook info |

The root endpoint's advertised list omits `/api/signals`, `/api/research` and `/telegram/register-webhook`; those routes are nevertheless present in the deployed handler. Treat this as a documentation inconsistency, not evidence that the routes are absent.

## Runtime architecture

### Scheduled Worker
- Cron runs once per minute (`* * * * *`).
- The scheduled handler asks the `HyperliquidFeed` Durable Object to ensure its feed connection is active.
- It also calls `ensureTelegramWebhook`.
- The advisor cycle is rate-limited internally to a five-minute slot (`CYCLE = 300000`), so a one-minute cron does not imply one full advisor cycle per minute.

### HyperliquidFeed Durable Object
- Maintains the WebSocket connection and reconnect metadata.
- Keeps latest prices, in-memory history, latest order books, context history and alert timestamps.
- Persists these values through Durable Object `state.storage.get/put`.
- Persists D1 market samples, candles, context snapshots and hourly summaries using bounded write intervals. The old `market_book_snapshots` table is no longer written to; live order-book snapshots stay in the Durable Object to avoid high-volume D1 writes.
- The public `/health` endpoint checks the feed's connected state and latest tick freshness.

### Advisor engine
- Uses cached one-minute price samples and market evidence.
- Contains trend/momentum/breakout and range/bounce analysis, RSI/EMA calculations, regime classification, event intelligence and position management.
- Contains a local five-minute statistical forecast (`CIEL Statistical Ensemble v1`) using existing price history. Its own source comment says it uses Worker CPU/in-memory history, with no Workers AI request and no additional D1/KV write.
- Gemini is an optional market-context reviewer with multiple key slots and cooldown state. The code includes a GDELT DOC 2.0 event-intelligence path with triggered-only search policy. This is not Google Search.
- Telegram notifications include inline callback actions for start, skip and close. The callback handler updates advisory position state; it does not place an exchange order.

### Telegram
- `/telegram/register-webhook` requires the webhook secret as a Bearer token and configures Telegram for `message` and `callback_query` updates.
- Incoming webhook requests are validated by the Telegram handler using the secret header.
- Notification delivery uses Telegram's Bot API.
- End-to-end delivery and button callback operation still need a staging smoke test.

## Trading and margin behavior found in the actual code

The recovered bundle contains this maximum-leverage map:

```js
BTC: 1001, ETH: 1001, MON: 25, BNB: 50, XRP: 100,
HYPE: 50, ONDO: 50, KPEPE: 50, QNT: 5, ZEC: 25,
TRX: 50, AAVE: 50, ADA: 50, CASHCAT: 3, DOGE: 50,
LINK: 50, LIT: 5, PONS: 3, PUMP: 50, SEI: 50,
SOL: 100, SUI: 50, UNI: 50, VIRTUAL: 50, XMR: 25
```

The production baseline paper account defaults to 60 MON, a 22 MON paper margin and 50x leverage. `minimumMarginForMarketLeverage()` returns 22 MON for 50x, 11 MON for leverage >=100x, and null for other values. The original production code rejected all non-50x markets, so the 100x+ branch was unreachable. The isolated staging patch enables verified 100x markets at a conservative 100x simulation baseline, stores the same 11 MON / 100x in the advisor proposal, corrects BTC/ETH from 1001x to 100x, and makes Telegram setup/open/help/profits copy tier-aware. The current watchlist has no verified 1000x market. The verified global minimum notional is $20; exact MON collateral remains dependent on live CR.

This is a concrete code inconsistency to fix after verifying the exchange's real constraints. Do not use the static map as proof of current market max leverage or minimum collateral.

## Configuration recovered from Cloudflare

- Worker: `ciel`
- Active version: `505`
- Migration tag: `v2`
- Compatibility date: `2026-09-08`
- Compatibility flag: `nodejs_compat`
- Usage model: `standard`
- Cron: every minute
- D1 binding: `DB` → database `ciel`
- KV binding: `CIEL_STATE` → namespace `ciel_state`
- DO binding: `HYPERLIQUID_FEED` → class `HyperliquidFeed`
- DO binding: `TRADING_ENGINE` → class `TradingEngine`

Non-secret runtime variables and secret names are in `../README.md` and `wrangler.jsonc`. Secret values are deliberately absent.

## D1 schema

The current `ciel` D1 database is approximately 35,086,336 bytes and has 16 application tables plus 14 indexes at the latest read-only inventory. The live schema exactly matches the recovered migration. The recovered live schema is `migrations/0000_recovered_live_schema.sql`. It includes market/advisor tables and older token-trading tables such as `tokens`, `signals`, `trades`, `positions`, `live_positions` and `live_executions`. Do not drop those legacy tables simply because the current Worker code is read-only.

## Known gaps and defects to address

1. **LeverUp margin model mismatch:** the original 100x+ 11 MON branch existed but paper trading rejected non-50x markets. The isolated `audit/paper-trading-fix` branch now enables supported 100x+ tiers, aligns proposal records and Telegram estimates, and tests open/close lifecycle; the static market map still needs authoritative LeverUp verification.
2. **Symbol mapping/feed coverage:** the live feed currently reports 24/25 prices and 23/25 order books. QNT has no price/book; KPEPE has a price but no book. A possible `xyz:QNT` alias needs a fresh allMids/meta/l2Book verification before adding an explicit mapping. Do not treat QNT as usable until both price and context/book are available.
3. **Alert delivery:** worker health does not prove Telegram messages or inline callbacks are working. Audit send failures and test callback actions.
4. **D1 migrations:** live schema is recovered, but original ordered migration files are not. The bundle references `migrations/0004_market_monitor.sql`; the exact historical migration chain must be reconstructed from schema and queries.
5. **Durable Object migration history:** active version reports migration tag `v2`; the full original migration chain was not exposed by the inspected version metadata. The provided Wrangler config is a new-account staging template with target D1/KV placeholders, not a verified source-account migration history.
6. **State:** KV values and Durable Object storage were not copied. D1 schema is not a D1 data backup.
7. **Source map/build:** original TS source map, dependencies, package lock, tests and CI config were not present in the deployment export.

## Staging checklist before connecting deployment

- Reassemble source fragments and run `npm run check`.
- Review recovered route and DB queries against the exported schema.
- Recreate a clean D1 database from reviewed migrations; keep the source D1 untouched.
- Create target KV namespace and DO namespaces; define a fresh-target migration plan.
- Add Telegram and Gemini secrets through Cloudflare/GitLab protected variables only.
- Deploy to a staging Worker with a different name/route.
- Test /health, all GET APIs, webhook registration, incoming Telegram updates, callback buttons, scheduled feed startup and D1 write volume. Use a separate staging Telegram bot; do not reuse the production token.
- Verify 24/25 or full watchlist symbol coverage and resolve the QNT alias.
- Verify LeverUp leverage and minimum collateral per market from authoritative live data.
- Only then cut traffic over. Do not disable the existing source Worker during reconstruction.


## Byte-level recovery verification

The recovered Worker was reassembled to exactly 209,745 characters. Its SHA-256 is `24e6452b4a2854a1e37f864adcb201d588771460eed68bcd100f5cfbafd564b6`, matching the digest calculated directly from the Cloudflare deployed `index.js` export. REA independently recorded the same digest for `reconstructed/worker.js`. The reassembly script now enforces both the exact length and this SHA-256 before it writes the output.


## Latest source-account audit

The 2026-11-02 read-only account inventory is documented in `HANDOFF-2026-11-02.md`. It confirms 234 advisor position rows (225 expired, 4 closing, 2 closed, 3 cancelled) and 944 AI audit rows (113 APPROVE, 41 REJECT, 790 WAIT). The two supplied ONDO/ADA proposal IDs are present as expired manual-tracking proposals; their automatic paper entries are separate DO state.

The source account has one CIEL feed DO object and zero objects in the retired TradingEngine namespace. The protected DO internal paper ledger cannot be read via the available Cloudflare SQL API. D1 `paper_executions` is empty because it is not the current perp paper ledger.


## Hyperliquid symbol and book identity diagnostics (2026-11-02)

The public Hyperliquid checks resolved the missing-book causes:
- KPEPE is named `kPEPE` in default `allMids` and `metaAndAssetCtxs`. The metadata universe contains the asset and context. `l2Book` works for exact coin `kPEPE` (bid 0.004892 / ask 0.004894 at the check) but returns HTTP 500 for uppercase `KPEPE`. Production normalizes the market symbol to uppercase and then requests the book using that uppercase value, so its REST fallback misses this book. The staging patch now preserves the original upstream coin name while keeping canonical uppercase CIEL symbols.
- QNT is absent from default `allMids` and from `metaAndAssetCtxs` for both default and `xyz`. The `allMids` request for DEX `xyz` does return `xyz:QNT` (34.186 at the check), and `l2Book` works for `xyz:QNT` (bid 34.111 / ask 34.261). But no derivatives context was returned for QNT in either metadata universe. The production Worker does not request the xyz DEX price or map this alias. QNT therefore remains excluded from advisor-ready market coverage until a valid funding/OI/mark/oracle context source is found; price/book alone is insufficient.

This makes the current production coverage gap precise: KPEPE's book is fixable with a case-preserving coin name (patched for staging); QNT is a separate DEX alias plus missing derivatives-context problem (not silently patched into a complete signal).
