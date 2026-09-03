---
"@moonshot-ai/kimi-code": patch
---

Long conversations now keep more context before compacting: the Rust engine compacts against the real context window of the selected model instead of an assumed 128k budget.
