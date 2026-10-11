---
"@moonshot-ai/kimi-code": patch
---

Report a plugin manifest field that is not recognized instead of loading the plugin without it. A `kimi.plugin.json` that wrote `skill` for `skills`, or `mcp_servers` for `mcpServers`, used to install with no skills and no MCP servers and no diagnostic; it now reports the ignored field in `/plugins info`, naming the intended key when there is an obvious near match.
