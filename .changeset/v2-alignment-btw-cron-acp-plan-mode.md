---
"@moonshot-ai/kimi-code": patch
---

Align engine behaviors with the upstream v2 reference: side-channel (`/btw`) questions may again use the read-only tools Read, Grep and Glob; the `[cron]` config section and `KIMI_DISABLE_CRON` are honored; selecting the ACP "Plan" mode now activates plan mode instead of only switching permissions; Gemini 3 models receive the configured thinking depth; and assistant reasoning is replayed to OpenAI Responses models instead of being dropped.
