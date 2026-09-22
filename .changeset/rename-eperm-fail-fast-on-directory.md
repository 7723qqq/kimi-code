---
'@moonshot-ai/kimi-code': patch
---

Atomic state-file writes no longer stall for seconds when the target path is occupied by a directory: the Windows EPERM retry now covers only transiently held destinations and fails fast on permanent ones.
