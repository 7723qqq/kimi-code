---
"@moonshot-ai/kimi-code": patch
---

Reconnect workspace MCP servers with backoff when the connection drops: a server that fails to start or loses its transport now retries on a schedule instead of staying failed until you restart. Tune the wait with `[mcp] reconnect_initial_delay_ms` and `reconnect_max_delay_ms`.
