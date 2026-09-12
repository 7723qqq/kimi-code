---
'@moonshotai/kimi-code': patch
---

Fix subagent tool scoping: a profile's tool allowlist/denylist now matches MCP names as globs (`mcp__*`, `mcp__github__*`) and built-ins exactly (case-insensitively), the same rule the global `[tools]` switch uses — previously the built-in profiles' `mcp__*` grant matched nothing, so subagents lost every MCP tool. The `Agent` tool description now advertises each subagent type's tool scope (`Tools: all` / `Read, mcp__*` / `none`), mirroring v2 `resolveActiveToolNames`, so the model can pick a subagent by what it may actually do.
