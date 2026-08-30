---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/agent-core-v2": patch
---

Fix rare Windows write failures when two processes update the same file at once, such as two CLI instances sharing a workspace catalog; the atomic write now retries instead of failing.