---
"@moonshot-ai/kimi-code": patch
---

MCP connection attempts now fail as soon as the server process exits, instead of waiting out the full startup timeout.
