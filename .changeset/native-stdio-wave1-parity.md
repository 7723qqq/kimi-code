---
"@moonshot-ai/kimi-code": patch
---

Expose the Wave 1 harness capabilities over stdio sessions: btw side-channel turns (`session/start_btw`, `session/btw_prompt`, `session/btw_cancel`), deterministic title derivation (`session/generate_title`), and background-task list/output/stop — same semantics as the napi addon, resolved against each session's own pipeline.
