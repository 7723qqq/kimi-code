---
"@moonshot-ai/kimi-code": patch
---

Stop a model that reports its reasoning through the `reasoning_details` array from showing that reasoning a second time inside the answer: the summary is now kept as replay-only data instead of being rendered a second time, and the provider still receives the full array on the next request.
