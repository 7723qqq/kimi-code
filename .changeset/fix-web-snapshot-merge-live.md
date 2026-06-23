---
"@moonshot-ai/kimi-code": patch
---

When resyncing a session, preserve only live messages that arrived while the snapshot was in flight, so a resync does not briefly drop them — without re-adding optimistic bubbles or undone turns.
