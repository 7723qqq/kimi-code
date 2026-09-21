---
'@moonshot-ai/kimi-code': patch
---

A message steered into a running turn is no longer lost when the turn is cancelled before the steer is consumed: the engine's steer queue now survives the turn boundary, so the session's next turn picks the message up instead of dropping it.
