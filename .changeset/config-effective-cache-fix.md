---
'@moonshot-ai/agent-core-v2': patch
---

Remove the memoized effective-config cache in ConfigService. The cache was invalidated on raw/validated/env changes but some mutation paths missed the invalidation, returning stale effective config on later reads (22 config tests failed with it in place). `freshEffective` now recomputes on every read, trading a small cost for correctness.
