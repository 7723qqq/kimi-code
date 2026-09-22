---
'@moonshot-ai/kimi-code': patch
---

A compaction whose summarization request itself overflows now recovers instead of failing: the history is shrunk to 70% / 50% / 35% by attempt (at most three times) and retried, matching the upstream recovery loop. Previously only the generic retry path applied, and an overflow error is not retryable, so a provider that counts tokens slightly differently than the pre-shrink estimate failed the whole compaction.
