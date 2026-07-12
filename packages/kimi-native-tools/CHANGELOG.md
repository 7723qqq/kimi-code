# @moonshot-ai/kimi-native-tools

## 0.2.0

### Minor Changes

- [`dcf51dd`](https://github.com/MoonshotAI/kimi-code/commit/dcf51dd7947af9354da451f6eb2520347529959e) - Add a native-tools implementation, providing Rust-backed Read, Write, Edit, Grep, Glob, and Bash tools with automatic fallback to the TypeScript implementations. Enabled by default via the `KIMI_CODE_EXPERIMENTAL_NATIVE_TOOLS` flag; set `KIMI_CODE_EXPERIMENTAL_NATIVE_TOOLS=0` to opt out and use the TypeScript originals.

### Patch Changes

- [`c58880a`](https://github.com/MoonshotAI/kimi-code/commit/c58880a3fb76af21d6d4f2fbb30b1ee38a64a5e5) - Move native bash, grep, and structured grep execution to a background thread pool to avoid blocking the Node event loop, add an experimental flag for microtask-scheduled in-process RPC, remove redundant session-existence checks before prompt/skill/message operations, and parallelize per-agent state queries during session resume.
