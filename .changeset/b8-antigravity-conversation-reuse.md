---
"@moonshot-ai/kimi-code": patch
---

Continue an Antigravity conversation in the same agent thread on follow-up turns, instead of resending the whole transcript as one prompt. The thread is only reused when the new turn strictly extends the previous message list, so two sessions sharing a model never write into each other's thread.
