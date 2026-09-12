---
'@moonshot-ai/kimi-code': patch
---

Emit `event.model_catalog.changed` after a provider model refresh. The native server's `POST /providers:refresh`, `/providers:refresh_oauth` and `/providers/{id}:refresh` now push the per-provider diff (`{changed, unchanged, failed}` — the refresh result's own shape) on the global WebSocket lane, so the Web client refreshes its provider/model caches and can surface an "N models added" summary without re-diffing the whole config.
