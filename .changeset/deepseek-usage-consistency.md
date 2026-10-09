---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-code-sdk": patch
---

OpenAI-compatible usage semantics move into one module, and cache fields that contradict each other are no longer trusted.

- `usage`: the v2 engine's OpenAI-compatible usage parsing now lives in `human/llm/requester/bases/openai/usage.ts` (alongside the existing `reasoning-key.ts`), as the single home for that wire's usage semantics: DeepSeek's top-level `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` recognition, the fallback to OpenAI's `cached_tokens` / `prompt_tokens_details.cached_tokens`, and normalisation into `TokenUsage`. `format.ts` forwards instead of holding the logic. No import path or signature changes.
- `usage`: when the DeepSeek cache split is present but `hit + miss` exceeds `prompt_tokens`, the fields cannot both be right, so they are rejected and the OpenAI cached count is used instead. A response reporting 5000 hit / 0 miss against 100 prompt tokens was previously counted as 5000 cache-read input tokens — more than the request's whole input. A split summing to less than `prompt_tokens` is not rejected: an endpoint may report only part of the split.
- `kosong`: the shared `extractUsage` in `packages/kosong/src/providers/openai-common.ts` applies the same rule, so both engines now classify contradictory cache fields identically. Previously it trusted `prompt_cache_hit_tokens` unconditionally. This touches the shared wire contract: `apps/vis/server`, `@moonshot-ai/kimi-code-sdk` and `@moonshot-ai/kimi-code-oauth` consume it, and their behaviour changes only for payloads whose cache split is arithmetically impossible.
