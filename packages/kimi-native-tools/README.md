# @moonshot-ai/kimi-native-tools

Rust-native implementations of the core Kimi Code tools: `Read`, `Write`, `Edit`, `Grep`, `Glob`, and `Bash`.

This package is consumed by `@moonshot-ai/agent-core` and is bundled into the Kimi Code CLI. The native module is gated behind the `KIMI_CODE_EXPERIMENTAL_NATIVE_TOOLS` flag and falls back to the TypeScript implementations when disabled or unavailable.

## Building

Requires [Rust](https://rustup.rs/) and `@napi-rs/cli`.

```bash
# Local development build (current platform only)
pnpm build:debug

# Release build for the current platform
pnpm build
```

## Cross-platform artifacts

The published package must include prebuilt binaries for all supported platforms:

| Platform | Target triple | Artifact name |
|---|---|---|
| Windows x64 | `x86_64-pc-windows-msvc` | `kimi-native-tools.win32-x64-msvc.node` |
| macOS ARM64 | `aarch64-apple-darwin` | `kimi-native-tools.darwin-arm64.node` |
| macOS x64 | `x86_64-apple-darwin` | `kimi-native-tools.darwin-x64.node` |
| Linux x64 | `x86_64-unknown-linux-gnu` | `kimi-native-tools.linux-x64-gnu.node` |
| Linux ARM64 | `aarch64-unknown-linux-gnu` | `kimi-native-tools.linux-arm64-gnu.node` |

Build each target with:

```bash
rustup target add <target-triple>
napi build --platform --release --target <target-triple>
```

CI should run the above for every target, then publish with `napi artifacts` so all `.node` files are included in the package tarball.
