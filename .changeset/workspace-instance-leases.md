---
"@moonshot-ai/kimi-code": patch
---

Fix workspace resources (runtimes, MCP connections, file watchers) leaking for the life of the process; they are now released once the last session using the workspace closes. A directory added with `persist: false` no longer survives that release.
