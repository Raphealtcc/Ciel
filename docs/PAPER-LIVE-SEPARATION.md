# CIEL paper/live separation

## Runtime controls

- `PAPER_TRADING_ENABLED=false` is the default. It prevents new automatic paper entries.
- Existing paper positions remain marked and managed until their normal stop, target, profit-protection or maximum-hold exit. This avoids stale OPEN records and preserves clean outcomes.
- Set `PAPER_TRADING_ENABLED=true` to resume paper entries. No ledger reset is required.
- `/profits` and historical paper records remain available while new entries are paused.

## Separation boundaries

- Paper fills, marks and simulated P&L remain based on Hyperliquid.
- Paper balance, open paper positions and paper margin eligibility must not suppress live candidate discovery.
- Adaptive learning continues to read historical closed paper trades while entries are paused. It uses up to 300 closed trades from the preceding 90 days, requires eight samples before adjusting a strategy, and only changes candidate ranking within a bounded multiplier. It does not set LeverUp margin, leverage or portfolio risk.
- Live margin is sourced from the LeverUp-specific margin setting and is clamped again by the live account snapshot, venue minimum, available WMON, fees and portfolio-risk coordinator.

## Price-source boundary

CIEL's technical candidate generation still consumes Hyperliquid candles, order-book and derivatives context. Live LeverUp preflight reads the LeverUp/Pyth oracle and pool/account state; the market-open plan uses that oracle for stop and target calculations and LeverUp handles the actual order. Paper simulation and live execution are separate, but the technical signal feed remains Hyperliquid-derived. A fully LeverUp-only signal feed requires a separate continuous LeverUp/Pyth history collector; one preflight oracle read cannot replace OHLCV history.

## Paper balance above 150 MON

Paper margin sizing is based on `startingBalanceMon`, not merely current equity. If the persisted starting balance itself is 150 MON, the 5% per-trade and 10% combined open-stop-risk budgets rise by 50%, permitting larger positions and larger MON losses. A rise in equity alone does not change the sizing ceiling while `startingBalanceMon` remains 100. This is a position-size effect, not proof that signal accuracy deteriorates. Adaptive ranking is separately bounded and does not directly increase size.
