---
"@moonshot-ai/kaos": patch
---

On Windows, `LocalProcess.kill()` no longer hangs when `taskkill /T /F` never reports back: the wait is now bounded at 5 s (the same deadline agent-core-v2's hostProcessService uses), after which the taskkill child is unref'd and killed and `kill()` resolves as the best-effort call it is.
