---
'@moonshot-ai/kimi-code': patch
---

Make WaitFor actually wait for background tasks, and let a steering message end that wait early. WaitFor can now be called without a task ID to wait for whichever background task finishes first.
