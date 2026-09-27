---
'@moonshot-ai/kimi-code': patch
---

Fix subagent tool scoping: a profile's tool allowlist/denylist now matches MCP names as globs (`mcp__*`, `mcp__github__*`) and built-ins exactly and case-insensitively, so subagents keep their MCP tools. The `Agent` tool description also advertises each subagent type's tool scope, so the model can pick one by what it may do.
