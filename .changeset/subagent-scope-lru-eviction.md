---
'@moonshot-ai/kimi-code': patch
---

Limit memory growth from finished subagents: completed subagent scopes are evicted once more than `KIMI_CODE_SUBAGENT_SCOPE_CACHE_SIZE` (default 32; `0` or negative = never evict) stay resident, and a resumed subagent is rebuilt from its saved conversation.
