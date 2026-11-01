# CIEL live runtime snapshot — 2026-11-01

Read-only HTTP checks against `https://ciel.leno3z4rrrri.workers.dev` were performed on 2026-11-01 around 09:20 UTC. These are point-in-time outputs, not persistent state or a guarantee of current market conditions.

## `GET /health`

**HTTP 200**

- `ok: true`
- `mode: read-only`
- `connected: true`
- `websocketConnected: true`
- `connectionState: open`
- `degraded: false`
- `fresh: true`
- Latest tick: 2026-11-01 09:20:34.618 UTC
- Latest message/pong: 2026-11-01 09:20:35.998 UTC
- Last connection open: 09:19:02.431 UTC
- Last close: 09:18:46.926 UTC
- Last close code: 1006, “WebSocket disconnected without sending Close frame.”
- Reconnect attempts: 1,100
- Last error: null

Interpretation: the feed was connected and fresh at the instant of the check, but the high reconnect count and recent 1006 close indicate recurring WebSocket churn. A green health response does not mean the connection has been continuously stable. Investigate reconnect cadence and close handling.

## `GET /api/signals`

**HTTP 200**

One proposed advisory setup was returned:

- Signal: `1263F488A9`
- Market: AAVE
- Side: SHORT
- Status: PROPOSED (not tracking)
- Reference entry: $136.53
- Current mid: $136.495
- Stop: $137.07612 (0.40%)
- Target: $135.43776 (0.80%)
- Confidence/technical strength: 0.77; the rationale explicitly says this is not a win probability.
- Strategy: TREND+MOMENTUM; TREND_HOLD
- RSI: 24.2
- 5m / 15m / 1h returns: -0.16% / -0.39% / -0.54%
- Collateral: 22 MON
- Leverage: 50x
- MON/USD feed value: $0.019401
- PnL: null because the setup is not being tracked and no manual entry was recorded.
- Mode: advisory-only

The rationale said Gemini APPROVE based on the provided market data, trend/momentum, negative funding and statistical forecast. It also labelled intraday context as MIXED and supplementary only. This is a proposal, not an executed position or an instruction to place a trade.

The response's PnL note assumes a 100% LeverUp MON collateral-ratio conversion and warns that actual results depend on LeverUp CR, mark/oracle, fills, fees, funding and slippage. That assumption must be replaced with verified market-specific values before using the estimate for a real trade.

## `GET /api/research`

**HTTP 200**

- Forecast model: `CIEL Statistical Ensemble v1`
- Horizon: 5 minutes; context window: 60 minutes
- Runs in the existing Worker CPU invocation using cached in-memory history.
- No Workers AI request; zero additional D1 writes, KV writes or cron jobs.
- The forecast's volatility envelope is explicitly heuristic, not a calibrated probability interval.
- Gemini model: `gemini-3.5-flash-lite`
- Google Search grounding: false
- External news research: true, using GDELT DOC 2.0 on a triggered-only policy.
- Event intelligence: no active event or pending review at the time of the read.
- Latest research row: AAVE SHORT, Gemini APPROVE.
- Previous recent row: ONDO SHORT, deterministic WAIT due to RSI 9.1 exhaustion without a confirmed same-side bounce.
- Another recent row: HYPE LONG, Gemini APPROVE.

The event-intelligence policy returned by the endpoint says it normally waits at least 45 minutes between external news queries; an active alert suppresses further searches for two hours, with an earlier retry only after another 2% BTC decline.

## What this proves — and what it does not

- It proves the deployed Worker was serving these endpoints and producing live market/advisory output at the time of the read.
- It proves the statistical forecast is local/in-process and the current model configuration is not using Google Search grounding.
- It does not prove Telegram delivery, callback button handling, exchange execution or LeverUp order placement.
- It does not prove a proposal is profitable or suitable for execution.
- The high reconnect counter warrants a separate stability investigation even though `/health` returned HTTP 200.

This snapshot is intentionally read-only. No trade was opened, no proposal was accepted, and no Worker configuration or live state was changed by these checks.
