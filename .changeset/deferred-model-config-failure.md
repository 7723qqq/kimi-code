---
'@moonshot-ai/kimi-code': patch
---

A model entry missing `max_context_size` now fails the prompt with an actionable config error instead of running a zero-token window into an opaque provider failure.
