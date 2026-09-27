---
"@moonshot-ai/kimi-code": patch
---

Pass `[thinking] keep` (or `KIMI_MODEL_THINKING_KEEP`) through to the native LLM transport on every entry point (native, ACP and the standalone server), so the provider keeps reasoning blocks across turns while Thinking is on.
