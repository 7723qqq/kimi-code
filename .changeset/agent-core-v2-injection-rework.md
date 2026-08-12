---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Rework the context-injection pipeline: injectors now reconcile at step heads instead of tracking positions, plugin session-start guidance is snapshotted and reconciled after compaction/undo, swarm reminders are replayable cross-model ops, and tool-schema injections drain at quiescent boundaries. Stuck-compaction detection now measures against the same full-request token baseline as auto-compaction, and a cancelled step during a retry backoff no longer mislabels the turn as a provider failure.
