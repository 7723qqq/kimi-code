---
'@moonshot-ai/kimi-code': patch
---

The transcript now records per-step LLM timing: first-token latency, stream duration, request build time and server time-to-first-token for every step, visible in session inspection. Previously the step timing fields existed in the protocol but were never filled.
