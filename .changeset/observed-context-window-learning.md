---
'@moonshot-ai/kimi-code': patch
---

After a context overflow, the engine now remembers the model's real window and uses the smaller value for later turns, so switching to a smaller-window model no longer re-overflows and re-compacts on every turn. The observation is per-process and relearned after a restart.
