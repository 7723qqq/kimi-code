---
"@moonshot-ai/kimi-code": patch
---

Wait for the engine to release a session before closing it, so deleting a session no longer races the engine's own teardown.
