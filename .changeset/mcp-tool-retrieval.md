---
"@moonshot-ai/kimi-code": minor
---

When dynamic tool loading is available, large MCP catalogs now load on demand: servers with 24 or more enabled tools are deferred automatically (set `[mcp] auto_defer_tool_threshold` to tune this, or `0` to disable), each turn lists up to ten relevant tools, and `select_tools` can search the rest by capability.
