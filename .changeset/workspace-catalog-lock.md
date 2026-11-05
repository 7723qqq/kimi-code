---
"@moonshot-ai/kimi-code": patch
---

Fix the CLI failing with "storage write failed: permission denied" when another Kimi Code process is running: the shared workspace catalog is now written under a cross-process lock.
