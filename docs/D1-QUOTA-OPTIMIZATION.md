# CIEL D1 quota optimization — 2026-11-03

## Measured baseline

Cloudflare D1 analytics for the isolated `ciel-paper-staging` database on 2026-11-03 reported 6,186 rows written by 02:36 UTC. The most recent 35-minute window showed approximately 1,350 rows written. A straight-line projection was approximately 55,000 rows/day against the Free-plan allowance of 100,000 rows written/day. Analytics are adaptive and the projection is an estimate, not a guarantee.

The largest removable duplicate was the core scalp's closed one-minute candle copy in D1. The strategy already fetches the same native candles from Hyperliquid every minute. The public `/api/candles?interval=1m` route reads `market_samples`, not the `market_candles` 1m table.

## Change

- Continue fetching closed BTC, ETH and SOL 1m candles every minute.
- Keep the rolling last 60 candles in `HyperliquidFeed` Durable Object storage and restore them after DO restarts.
- Run the core scalp analyzer from that same persistent DO candle cache.
- Keep native 5m candle history in D1 for trend confirmation, historical charting and hourly summaries.
- Keep 1m benchmark samples, wider-watchlist sample persistence, live price sampling, alerts, market-quality context, retention, paper trading, Telegram and all other routes unchanged.

This removes only the duplicate D1 writes for core scalp 1m candles and also removes the corresponding D1 1m-candle reads. It does not slow the live 1m candle fetch or the scalp evaluation cadence.

## Expected impact

The 1m candle insert/replace queries accounted for approximately 441 D1 rows written in the sampled 35-minute window. Removing those duplicate writes should lower the observed write rate by roughly one-third, subject to market activity and Cloudflare's adaptive sampling. The rough projection falls from about 55,000 to about 37,000–40,000 rows/day. Verify against D1 Metrics > Row Metrics after deployment.

## Safety / functionality checks

The D1 efficiency test verifies that the DO cache is restored and used by the core scalp analyzer, that no 1m candle D1 writes or reads remain in that path, and that the public 1m candle endpoint, native 5m candles, two-minute live context, 15-minute historical context, alerts and existing sample history remain in place.