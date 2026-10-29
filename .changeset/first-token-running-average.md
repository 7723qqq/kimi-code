---
"@moonshot-ai/kimi-code": patch
---

Keep the first-token average in constant time: the status strip no longer copies the whole sample array on every step or scans it on every frame. The displayed value is unchanged — it is still the exact mean of every sample in the session.
