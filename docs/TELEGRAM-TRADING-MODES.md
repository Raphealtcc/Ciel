# Telegram trading modes

- `/paperactive`: allow new paper entries.
- `/paperdeactivate`: stop new paper entries; existing paper positions continue to be managed.
- `/liveactive`: allow new LeverUp entries only if the Cloudflare kill switch is already OFF and preflight, wallet keys and addresses are configured. All execution checks remain mandatory.
- `/livedeactivate`: stop new live entries while retaining management and risk-reducing exits for existing live positions; it does not close positions.
- `/modes`: show effective states.

Overrides are stored in the existing CIEL_STATE KV namespace. Telegram commands remain restricted to TELEGRAM_CHAT_ID. The independent Cloudflare kill switch cannot be bypassed.
