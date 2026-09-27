---
"@moonshot-ai/kimi-code": patch
---

Stop the busy indicator from wedging forever after a queued turn is cancelled: the cancel event is now part of the protocol vocabulary, forwarded by the host, and handled by the TUI and the web UI.
