---
"@moonshot-ai/kimi-code": patch
---

Fix providers configured with `api_key_env` sending requests with an empty credential on the engine-run surfaces (`kimi web`, `kimi-agent --repl`).
