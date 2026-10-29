---
"@moonshot-ai/kimi-code": patch
---

Release a workspace handler's previous lease when the same workspace is acquired again. Repeated or concurrent handler resolution used to overwrite the stored lease without disposing it, so the workspace runtime, its MCP connections and its file watchers were never torn down even after every session had closed.
