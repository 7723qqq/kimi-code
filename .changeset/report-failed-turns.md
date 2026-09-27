---
"@moonshot-ai/kimi-code": patch
---

Report why a turn failed instead of ending it silently, with a classified code such as `provider.api_error` or `provider.rate_limit`, and surface engine turn warnings (media budget, MCP startup) in the UI again.
