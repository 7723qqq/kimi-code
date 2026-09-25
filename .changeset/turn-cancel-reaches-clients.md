---
"@moonshot-ai/kimi-code": patch
---

Stop the busy indicator from wedging forever after a turn is cancelled while it is still queued. Such a turn never starts, so it emits no `turn.ended` — and its only terminal signal, `turn.cancel` (v2 `TurnCancel`), was dropped on the way to every client: it was missing from the protocol's event union and the native client forwarded only `turn.started` / `turn.ended`. The event is now part of the protocol vocabulary, forwarded by the host, and handled on the client side — the TUI and this repo's web UI source both clear the working state, and the prebuilt web bundle picks it up on its next sync. The active target stays untouched: its own `turn.ended(cancelled)` closes it.
