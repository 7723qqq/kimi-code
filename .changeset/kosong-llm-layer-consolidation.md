---
"@moonshot-ai/kosong": minor
"@moonshot-ai/agent-core-v2": minor
---

Consolidate the dual kosong LLM abstractions into a single shared layer in `@moonshot-ai/kosong`:

- Move the error infrastructure (Error2 + codes + serialize), the contract layer (message/tool/usage/capability/provider/generate/errors/tokens/inspection/request-trace), and the provider pure-function layer (openai-common, tool-call-id, request-auth, merge-user-messages, reasoning-key, chat-completions-stream, anthropic-profile, kimi-schema, kimi-errors, capability-registry) into `@moonshot-ai/kosong`; the engine re-exports them unchanged
- Unify the `ChatProvider` contract on the `GenerateOptions` style; legacy morph methods stay as optional members
- Delete dead code (native-bridge, astron) and mark legacy standalone providers deprecated
- Harden the engine wire layer: warn once on unregistered (provider, protocol) pairs, guard the auth-refresh replay against duplicated stream parts, bound the requester event queue, and remove dead surface (`resolveProviderBaseId`, `effectiveMaxCompletionTokens`)
