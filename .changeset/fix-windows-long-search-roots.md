---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Fix file searches failing in long Windows directories. `Glob` now runs ripgrep from a shorter parent directory when the search root exceeds the Windows path limit, rewriting the glob patterns so the matched files and their order are unchanged.