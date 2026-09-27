---
"@moonshot-ai/kimi-code": patch
---

Compaction now uses the context window resolved for the session's own model, so a model declaring a 1M-token window is no longer compacted at the 128k default. The summary keeps the task state, exact paths, commands and a forward plan.
