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
  error classification, and the surviving provider metadata helpers
  (`anthropic-profile`, `astron-models`).

## Consumers

The retired TypeScript engine (`agent-core-v2`) was the original consumer; its
successor, the Rust engine (`packages/kimi-agent`), consumes the contract via
frozen generated types instead. Today this package is imported by
`packages/node-sdk`, `packages/oauth`, and `apps/vis/server`, and re-exported
through the SDK seam (`@moonshot-ai/kimi-code-sdk`).

## License

MIT
