---
"@moonshot-ai/kimi-agent": patch
---

Cap `max_tokens` at 64000 for an Anthropic model the engine does not recognize, matching the upstream profile's fallback instead of the previous 128000.
