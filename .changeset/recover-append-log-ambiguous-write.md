---
"@moonshot-ai/kimi-code": patch
---

Stop append-log flushes from getting stuck in a permanent failure loop when a batch that already reached disk is reported as failed; the next flush now treats the zero-byte remainder as success instead of replaying the error and dropping newly appended records.
