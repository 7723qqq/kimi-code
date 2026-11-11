---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Classify stdio MCP startup failures caused by a missing or inaccessible command as configuration errors. When a configured command (for example a script such as `npx`) cannot start, the client now reports a clear config error carrying the underlying cause instead of an opaque transport failure.