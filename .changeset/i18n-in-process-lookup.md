---
'@moonshot-ai/kimi-code': patch
---

Fix high CPU use during turns and streaming: `t()` no longer ships the whole locale JSON across the napi boundary on every call (about 290 µs per lookup) and translates in-process instead (about 0.05 µs), so render-heavy paths stop saturating a core with bridge traffic.
