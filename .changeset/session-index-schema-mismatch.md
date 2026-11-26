---
"@moonshot-ai/agent-core-v2": patch
---

Serve session reads from the authoritative files instead of re-projecting when the published session-index schema version differs, so an older client cannot overwrite a newer index.
