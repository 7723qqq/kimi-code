---
"@moonshot-ai/kimi-code": patch
---

Name the event that repeated in the dispatch-cascade error. The cycle guard reports how deep the cascade went and which type overran the per-type limit, but the type itself only reached the error details, so the failure surfaced as an unusable "possible event cycle" in the interface. The message now carries the repeated type and the queued type sequence.
