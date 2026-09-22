---
'@moonshot-ai/kimi-code': patch
---

Failed LLM requests now fail fast on the statuses that are deterministic rather than transient: the retry set is the explicit list 408/409/429/500/502/503/504/529 (501, 505, 506, 507, 508 and the rest of the 5xx range no longer burn the retry budget), and a 429 whose body says the account exceeded its current token quota is recognized as quota exhaustion instead of a rate limit.
