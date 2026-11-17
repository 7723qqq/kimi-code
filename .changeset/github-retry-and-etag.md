---
"@moonshot-ai/kimi-code": patch
---

Survive GitHub's transient failures: a 429 or 5xx is retried once (honoring `Retry-After` under 30 seconds), and repeated reads of an unchanged resource are revalidated with an ETag instead of spending the rate-limit budget again.
