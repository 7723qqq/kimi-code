---
"@moonshot-ai/kimi-code": patch
---

MCP tool calls stop hanging: a server whose connection has already died is refused immediately, and one call no longer runs past its configured timeout.
