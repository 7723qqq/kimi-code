---
"@moonshot-ai/kimi-code-sdk": patch
---

Add the `prompt_optimizer.output_too_long` error code, returned when a prompt rewrite exceeds the engine's output limit. The rewrite is rejected rather than silently truncated. Also correct `prompt_optimizer.no_output` to `retryable: true`, matching the engine's registration.
