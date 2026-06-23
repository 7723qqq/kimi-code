---
"@moonshot-ai/kimi-code": patch
---

Merge the session snapshot with live-appended messages when resyncing, so messages that arrive while the snapshot is in flight are not briefly dropped.
