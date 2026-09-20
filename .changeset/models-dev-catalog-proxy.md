---
'@moonshot-ai/kimi-code': patch
---

Serve the provider catalog from models.dev: GET /catalog/providers and /catalog/providers/{id} proxy the upstream directory through a 10-minute TTL cache with in-flight dedup and a built-in snapshot fallback, and POST /providers:import_catalog writes a catalog entry into the config as a provider with its model aliases.
