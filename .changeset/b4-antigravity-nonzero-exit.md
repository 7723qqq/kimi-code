---
"@moonshot-ai/kimi-code": patch
---

Report an Antigravity turn as failed when the agent process exits non-zero after sending its answer, instead of finishing as if the answer were complete. The truncated text is still delivered, then the turn ends with an error so it is retried or surfaced rather than silently accepted.
