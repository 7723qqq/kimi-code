---
"@moonshot-ai/kimi-code": patch
---

Route the native WebSearch and FetchURL tools through the host-resolved `[services.moonshot_search]` / `[services.moonshot_fetch]` backends (`KIMI_WEB_SEARCH_*` / `KIMI_WEB_FETCH_*`) when configured, instead of the built-in DuckDuckGo scrape / direct fetch (which stays the fallback for fetch failures).
