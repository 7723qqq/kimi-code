---
'@moonshot-ai/kimi-code': patch
'@moonshot-ai/kimi-code-sdk': patch
---

File suggestions and the session-less MCP listing now work on the native engine.

`suggestFiles` was a stub that returned `undefined`, so the VS Code extension's `@`-mention file picker silently fell back to its own scan. It now reaches the engine's own search through a new `fsSuggest` napi export, and that search reports real `match_positions` for highlighting — the HTTP `fs::suggest` route gained the same field, so the Web UI and the inspector stop rendering an empty highlight frame.

`listWorkspaceMcpServers` returned a hardcoded `[]`, so `/mcp` showed nothing before the first session existed. It now reports the servers configured in `mcp.json` with status `pending`: nothing is connected until the engine builds a session pipeline, so claiming `connected` would be wrong.
