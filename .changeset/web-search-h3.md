---
"@moonshot-ai/agent-core-v2": minor
---

Local web-search engines opportunistically use HTTP/3 on Bun runtimes: each origin is probed once in the background and successful origins are remembered for the session, halving repeat-query latency on supporting hosts like cn.bing.com (KIMI_CODE_SEARCH_H3=0 disables).
