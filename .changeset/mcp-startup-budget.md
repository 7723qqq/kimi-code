---
"@moonshot-ai/kimi-code": patch
---

MCP startup now waits at most two seconds before the first turn proceeds; slow servers keep connecting in the background, and servers that fail because of a missing runtime or capability stay failed instead of reconnecting.
