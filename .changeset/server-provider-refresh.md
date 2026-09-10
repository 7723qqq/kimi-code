---
'@moonshot-ai/kimi-code': patch
---

Add provider model refresh to the local server: POST /providers/{id}:refresh, /providers:refresh and /providers:refresh_oauth re-read the managed Kimi Code /models endpoint and rewrite the provider's model aliases.
