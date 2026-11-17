---
"@moonshot-ai/kimi-code": patch
---

Fail an LLM request that stops responding instead of waiting on it forever: the two timeout variables now apply on the Bun runtime, whose `fetch` ignores the HTTP dispatcher they used to configure.
