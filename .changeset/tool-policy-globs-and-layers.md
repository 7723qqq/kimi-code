---
"@moonshot-ai/kimi-code": patch
---

Tool enable and disable patterns for MCP servers now understand the full glob syntax (`?`, `[]`, `{}`, `**`) instead of `*` alone, and workspace, profile and session level restrictions combine the way the reference implementation does.