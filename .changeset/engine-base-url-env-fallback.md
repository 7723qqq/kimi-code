---
"@moonshot-ai/kimi-code": patch
---

Fall back to the provider type's base URL environment variable (`KIMI_BASE_URL`, `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`) and then its default endpoint when a provider declares no `base_url`, on the surfaces that run sessions on the engine directly (`kimi acp`, `kimi web`).
