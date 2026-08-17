---
"@moonshot-ai/kosong": minor
"@moonshot-ai/agent-core-v2": minor
---

Consolidate the dual kosong LLM abstractions into a single shared layer in `@moonshot-ai/kosong`:

- Move the error infrastructure (Error2 + codes + serialize), the contract layer (message/tool/usage/capability/provider/generate/errors/tokens/inspection/request-trace), and the provider pure-function layer (openai-common, tool-call-id, request-auth, merge-user-messages, reasoning-key, chat-completions-stream, anthropic-profile, kimi-schema, kimi-errors, capability-registry) into `@moonshot-ai/kosong`; the engine re-exports them unchanged
- Unify the `ChatProvider` contract on the `GenerateOptions` style; legacy morph methods stay as optional members
- Delete dead code (native-bridge, astron) and mark legacy standalone providers deprecated
- Harden the engine wire layer: warn once on unregistered (provider, protocol) pairs, guard the auth-refresh replay against duplicated stream parts, bound the requester event queue, and remove dead surface (`resolveProviderBaseId`, `effectiveMaxCompletionTokens`)

Behavior changes for `@moonshot-ai/kosong` consumers (the engine already used the new semantics):

- `extractUsage` now reports cache misses in `inputOther` and keeps `inputCacheCreation` at 0 for OpenAI-compatible endpoints (DeepSeek `prompt_cache_miss_tokens` and the non-cached prompt remainder moved from `inputCacheCreation` to `inputOther`)
- `ChatProviderError` and the `API*Error` family now extend the coded `Error2` base (a `code` property is set at construction); constructor signatures stay compatible
- `APIStatusError` sanitizes the message at construction (HTML `<title>` extraction, `\r` removal) and appends a thinking-effort config hint on 400/422 effort rejections
- `estimateTokensForTools` applies the JSON ×1.3 multiplier to the summed estimate (previously per-tool), matching the native batch path
