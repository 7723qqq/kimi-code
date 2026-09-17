---
"@moonshot-ai/kimi-code": patch
---

Background tasks settled after their session is gone no longer leak late completions: the engine now asks the host whether the owning session is still alive at settle time, and stays fully silent (no terminal events, no queued notification) when it is not. The task itself still terminates and stays visible on the task surface.
