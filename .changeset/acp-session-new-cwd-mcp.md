---
'@moonshot-ai/kimi-code': patch
---

Honor `cwd` and `mcpServers` on ACP `session/new`. The requested working directory is registered as a workspace and bound to the session (so its tools run there and `session/list`'s cwd filter resolves it), and each client-supplied MCP server is connected through the engine's MCP manager (stdio / http / sse transports).
