---
"@moonshot-ai/kap-server": patch
"@moonshot-ai/kimi-code": patch
---

Isolate global search into a dedicated worker thread with a versioned handshake, per-request watchdog budgets, orphaned-lock recovery, and a boot-salted page-token scheme. Search now degrades gracefully to `building`/`degraded` states on worker crash instead of blocking the server thread, and oversized WAL replays no longer trip the short-request watchdog.
