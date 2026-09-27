---
'@moonshot-ai/kimi-code': minor
'@moonshot-ai/kimi-code-sdk': minor
---

Installed plugins now contribute: an enabled plugin's `skills` directories join the engine's skill scan and its `mcpServers` join the session's MCP connections, namespaced per plugin so two plugins can declare the same server name. A plugin whose catalog `source` is a GitHub repository or zip URL can now be installed, with the download checked against private addresses and extraction refusing any path that would escape the plugin directory.
