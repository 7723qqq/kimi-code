---
'@moonshot-ai/kimi-code': patch
---

`kimi export` now rejects session ids that are not a single path segment (for example `../outside` or `a/b`) instead of resolving them against the session directory.
