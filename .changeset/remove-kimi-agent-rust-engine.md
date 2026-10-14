---
"@moonshot-ai/kimi-code": patch
---

The experimental Rust agent engine is gone from this fork: `packages/kimi-agent/` (the `@moonshot-ai/kimi-agent` napi-rs addon and its CLI), the `kimi-agent` native-asset entry in the packaging scripts, the `make rust-*` targets, the cargo vendor/build steps in `flake.nix`, and the two CI steps that built and tested it. Nothing ever imported the package — `runTurnRust`, `createRunTurnOverride`, `isRustEngineAvailable` and `shutdownRustEngine` had no callers — so the JavaScript engine was already the only path taken at runtime, and a build that shipped the addon only paid for its bytes.

The config surface that existed only to configure that engine goes with it: the `[agent]` section (`engine`, `multi_llm`, `native_llm_provider`, `native_tools`) and the SDK's `AgentConfigSchema` / `AgentConfig` exports are removed. An existing `config.toml` that still carries an `[agent]` section is not rejected — the section is simply ignored on load — and `tui.slashCommands.multiLlm` is dropped from both locales.

Deploying this needs one hash update: removing the second vendored Rust crate tree changed the `bunDeps` fixed-output derivation in `flake.nix`, so its `outputHash` must be recomputed with the usual fake-hash round (set `lib.fakeSha256`, push, paste the `got:` hash).
