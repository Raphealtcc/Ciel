# CIEL2 market breadth and persistent order-flow research

## Purpose

This change adds two independent, shadow-only measurements to the existing signal audit and Telegram proposal. Neither measurement changes candidate generation, quality thresholds, paper entry eligibility, LeverUp preflight, or live execution.

The objective is to collect evidence first. Do not promote either feature into an entry veto or score bonus until it demonstrates incremental out-of-sample value after costs.

## 1. Cross-asset breadth

- Uses the current configured Hyperliquid watchlist, not an invented broad-market universe.
- Excludes the candidate symbol and MON.
- Includes only symbols with a fresh market-context observation and at least $250,000 in reported 24-hour notional volume.
- Calculates equal-weight advance/decline breadth over sampled 5-minute and 15-minute returns.
- Requires at least eight eligible observations at both horizons; otherwise it reports INSUFFICIENT_COVERAGE.
- Stores the up-share, median returns, sample counts, universe size, and observation time in the existing market-context audit JSON.
- It does not create D1 tables or extra D1 writes.

This is watchlist breadth, not total-market breadth. The watchlist composition and survivorship can bias it. It is descriptive context, not a forecast.

## 2. Persistent order-flow confirmation

- Subscribes to Hyperliquid L2 book and public trade streams for BTC, ETH, and SOL only.
- Computes best-quote order-flow imbalance from consecutive snapshots using bid/ask price and size changes.
- Separately computes signed trade notional from buyer/seller aggressor side.
- Summarizes the latest 30 seconds, requiring at least eight book events, five trades, two active 10-second buckets, agreement across the bucket signs, and minimum normalized book/trade imbalance.
- Labels the result PERSISTENT, MIXED, INSUFFICIENT, or STALE.
- Keeps a bounded rolling event buffer in the existing Durable Object storage. It does not write every snapshot to D1.
- If the Hyperliquid feed is disabled under the existing live-mode separation, this feature is unavailable rather than substituting LeverUp execution prices or pretending the stream is active.

This is a top-quote OFI proxy, not full-depth queue reconstruction, L4 order tracking, cancellation classification, or proof of informed trading. It can be spoofed and it decays quickly.

## Validation protocol before using either feature as a gate

1. Capture timestamped breadth, OFI, trade imbalance, candidate side, strategy, and the existing signal decision.
2. Compare baseline recommendations with breadth-only and OFI-only shadow subsets. Do not combine them initially.
3. Use forward 1m/5m/15m returns and the existing target/stop/time-exit labels. Use non-overlapping evaluation windows or purge/embargo overlapping labels.
4. Split chronologically into development and untouched out-of-sample periods. Freeze thresholds before the final holdout.
5. Report sample count, coverage, missing-data rate, precision/recall by side and strategy, expectancy in R, drawdown, and net expectancy after spread, fees, slippage, and funding.
6. Check stability by BTC/ETH/SOL, volatility regime, weekday, and month. Avoid selecting a threshold from a single short regime.
7. Do not use a feature if its apparent gain disappears after costs or does not repeat out of sample.

## Research notes

- Hyperliquid documents `l2Book` and `trades` WebSocket subscriptions and explicitly warns clients to handle disconnects/reconnects. The implementation uses the existing Durable Object connection and existing reconnect behavior.
- The public Hyperliquid data-pipeline example computes event-level OFI and evaluates forward mid-price moves with Newey-West statistics and cost-aware simulation. It is a methodology reference, not code copied into CIEL2.
- Recent research on world order flow finds cross-sectional predictive information in a multi-asset setting, while other recent work emphasizes time-varying signal predictability and the danger of data-snooping. This supports testing breadth but not assuming it will be stable.
- Recent microstructure research and community reports both warn that order-book signals can have very short half-lives and that gross price predictability can be smaller than trading costs. That is why order-flow is measured independently and remains shadow-only.

## References

- Hyperliquid WebSocket: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket
- Hyperliquid subscriptions and L2/trade payloads: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions
- Hyperliquid rate limits: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits
- Hyperliquid OFI data pipeline reference: https://github.com/Giri-Aayush/hyperliquid-data-pipeline
- Crypto cross-sectional predictability and time variation: https://papers.ssrn.com/sol3/papers.cfm?abstract_id=7556359
- Order flow and cryptocurrency returns: https://doi.org/10.1016/j.finmar.2026.101047
- Community discussion of short OFI half-life and fee drag: https://www.reddit.com/r/mltraders/comments/1xbgirf/i_tested_order_book_imbalance_on_8_bybit_perps/
- Community discussion of OFI persistence and execution constraints: https://www.reddit.com/r/algotrading/comments/1pgsphr/algo_only_based_on_orderbook_imbalance_could_it/
Implementation status: the measurements are shadow-only until a chronological, cost-adjusted holdout supports changing the entry policy.
