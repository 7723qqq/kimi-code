---
'@moonshot-ai/kimi-code': patch
---

Failed LLM requests now fail fast on statuses that are deterministic rather than transient, and a 429 that reports the account exceeded its token quota is treated as quota exhaustion instead of a rate limit.
