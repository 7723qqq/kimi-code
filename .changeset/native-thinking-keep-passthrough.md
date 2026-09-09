---
"@moonshot-ai/kimi-code": patch
---

Pass `[thinking] keep` (or `KIMI_MODEL_THINKING_KEEP`) through to the native LLM transport: `thinking.keep` on kimi/OpenAI request bodies and a `clear_thinking_20251015` context-management edit (beta Messages API) on Anthropic. Off-values disable it; it is only injected while Thinking is on.
