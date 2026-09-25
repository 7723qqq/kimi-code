---
"@moonshot-ai/kimi-code": patch
---

Fix the interruption reminder never firing on the session path: the turn builder read the session's read-and-clear "previous turn aborted" flag twice, so the value it passed into the turn was always `false`. It now uses the single value it already read.
