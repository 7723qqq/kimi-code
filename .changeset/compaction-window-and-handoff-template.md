---
"@moonshot-ai/kimi-code": patch
---

Compaction now uses the context window the host resolved for the session's own model, so a model that declares a 1M-token window is no longer compacted at the 128k default (~81k tokens). The summarizer writes the upstream handoff summary (task state, the exact paths and commands, a forward plan) instead of a single-sentence paraphrase, a caller-supplied instruction is appended inside that template rather than replacing it, and an automatic compaction that has nowhere to split the history no longer announces a `compaction.completed` that folded nothing.
