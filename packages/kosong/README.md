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

## Relationship to agent-core-v2

`agent-core-v2` depends on this package. Its `src/kosong/` layer keeps the
DI/trait composition machinery (model services, protocol adapter registry,
protocol bases) and imports the contract/error/pure-function layers from
here — the engine's `contract/` directory is a thin re-export of this
package.

## License

MIT
