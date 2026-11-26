---
"@moonshot-ai/agent-core-v2": patch
---

Recover a turn from a provider context overflow that arrives as a structured `{ kind: "context_overflow" }` payload, so automatic compaction runs instead of failing the turn. Compaction no longer wraps the requester's own credential recovery, so a replayed 401 surfaces as a provider auth error instead of being retried a third time.
