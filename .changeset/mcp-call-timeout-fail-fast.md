---
"@moonshot-ai/kimi-code": patch
---

MCP tool calls stop hanging: a server whose connection has already died is refused immediately, one call no longer runs past its configured timeout, and a remote server with no configured timeout now gets the documented 60 seconds instead of 30.
