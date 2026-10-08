# @moonshot-ai/kosong

LLM abstraction layer used by Kimi Code — the single shared home for the
provider wire contract.

Part of the [Kimi Code](https://github.com/MoonshotAI/kimi-code) monorepo.

## What lives here

- **Contract types** — `Message` / `ContentPart` / `ToolCall` / `Tool` /
  `TokenUsage` / `ModelCapability` and the `ChatProvider` interface
  (GenerateOptions-style per-turn intents; legacy morph methods stay as
  optional members).
- **Error infrastructure** — the coded-error base (`Error2` + codes +
  serialization) and the provider error taxonomy (`API*Error` family,
  retry/telemetry classification). The engine re-exports the base classes
  unchanged.
- **Pure functions** — the `generate()` stream driver, token estimation,
  error classification, and the provider wire helpers (openai-common,
  tool-call-id, request-auth, merge-user-messages, reasoning-key,
  chat-completions-stream, anthropic-profile, kimi-schema, kimi-errors,
  capability-registry).
- **Standalone providers** — legacy `createProvider` surface
  (`KimiChatProvider` etc.), kept for the standalone path and its tests.
  The engine (agent-core-v2) composes its own trait-based providers from
  the shared layer above instead.

## Relationship to other packages

Nothing in `agent-core-v2` imports this package — the engine carries its own
provider wire layer (`src/llm-adapter/`), its own contract (`src/contract.ts`)
and its own error base. The consumers of this package are `@moonshot-ai/oauth`
and `@moonshot-ai/kimi-code-sdk`, which use the contract types, the error
taxonomy and the standalone `createProvider` surface directly.

## License

MIT
