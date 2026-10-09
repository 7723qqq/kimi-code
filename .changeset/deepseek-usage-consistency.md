---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-code-sdk": patch
---

OpenAI-compatible usage semantics move into one module, and cache fields that contradict each other are no longer trusted.

- `usage`: the v2 engine's OpenAI-compatible usage parsing now lives in `human/llm/requester/bases/openai/usage.ts` (alongside the existing `reasoning-key.ts`), as the single home for that wire's usage semantics: DeepSeek's top-level `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` recognition, the fallback to OpenAI's `cached_tokens` / `prompt_tokens_details.cached_tokens`, and normalisation into `TokenUsage`. `format.ts` forwards instead of holding the logic. No import path or signature changes.
- `usage`: when the DeepSeek cache split is present but `hit + miss` exceeds `prompt_tokens`, the fields cannot both be right, so they are rejected and the OpenAI cached count is used instead. A response reporting 5000 hit / 0 miss against 100 prompt tokens was previously counted as 5000 cache-read input tokens — more than the request's whole input. A split summing to less than `prompt_tokens` is not rejected: an endpoint may report only part of the split.
- known divergence: `@moonshot-ai/kosong` keeps the earlier behaviour, rejecting no split, because it is the shared provider wire contract and is out of scope here. The two engines therefore classify contradictory cache fields differently until that side is aligned deliberately.
