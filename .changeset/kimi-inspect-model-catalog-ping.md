---
'@moonshot-ai/kimi-code': patch
---

Fix the kimi-inspect Model Catalog panel: the debug RPC surface now serves `modelCatalog.ping` (one minimal request through the engine's own LLM selection), `modelService.list` (the raw model records) and `sessionManager.resume`, and the panel's per-model inspector — which called a method the server never served — is replaced by upstream's per-model Ping and + Session actions.
