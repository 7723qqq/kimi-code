---
"@moonshot-ai/kimi-code": patch
---

Fix long sessions overflowing the model's context window instead of compacting when the local token estimate undercounts the provider-reported usage.
