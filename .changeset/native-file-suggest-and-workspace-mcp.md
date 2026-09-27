---
'@moonshot-ai/kimi-code': patch
'@moonshot-ai/kimi-code-sdk': patch
---

File suggestions and the session-less MCP listing work on the native engine: the VS Code extension's `@`-mention file picker now gets real match positions for highlighting, the Web UI and inspector stop rendering an empty highlight frame, and `/mcp` lists the servers configured in `mcp.json` with a pending status before the first session exists.
