# @moonshot-ai/kimi-native-tools

High-performance native Node addon implemented in Rust (via napi-rs), accelerating performance-critical tasks across Kimi Code CLI.

This package is consumed directly by `apps/kimi-code`, `packages/i18n`, and other workspace packages, falling back gracefully to pure-TypeScript implementations when the native addon is not available.

## Implemented Native Tools & Capabilities

- **Filesystem & Execution Tools**:
  - `read` / `read_lines`: High-throughput file reading with encoding detection (UTF-8, UTF-16 LE/BE with BOM stripping) and line-level budget control.
  - `write` / `write_append`: Atomic overwrite (via temporary file replace) and append operations with automatic directory creation.
  - `edit`: Precise in-place string replacement with single/multiple match enforcement.
  - `grep`: Parallel ripgrep-powered text search with head/tail limits, offset, and deterministic sorting.
  - `glob`: Fast directory tree walking respecting `.gitignore` rules.
  - `bash` / `bash_spawn`: Process execution with process-tree cancellation, timeout enforcement, and real-time output streaming.
- **Text & Token Processing**:
  - `tokens`: Token estimation and forward/backward byte/character-budgeted truncation preserving UTF-8 multibyte character boundaries.
  - `translation`: In-memory translation caching and high-speed `{placeholder}` interpolation.
- **Web & Network**:
  - `fetch_url`: Native HTTP client with manual per-hop redirect resolution and strict SSRF protection.
  - `web_search`: DuckDuckGo HTML search results extraction and parsing.
- **Data & Indexing**:
  - `knowledge`: Embedded SQLite FTS (Full-Text Search) for workspace knowledge bases.
  - `workspace_index`: Fast project indexing and read prediction.
  - `tool_access`: Multi-tool concurrent resource access conflict detection.
  - `tool_naming`: Sanitization and deterministic hash qualification for external/MCP tools.
  - `image_compress`: Image downscaling, aspect ratio fitting, and quality ladder compression (JPEG/PNG).

## Building

Requires [Rust](https://rustup.rs/) (stable toolchain) and `@napi-rs/cli`.

```bash
# Local development build (current platform only)
bun run build:debug

# Release build for the current platform
bun run build

# Run unit tests (--lib: this is a cdylib crate, so `cargo test`
# without `--lib` fails on the unsupported doc-test target)
cargo test --lib
```

## Cross-platform Artifacts

The native package builds across a 6-target platform matrix:

| Platform | Target triple | Artifact name |
|---|---|---|
| Windows x64 | `x86_64-pc-windows-msvc` | `kimi-native-tools.win32-x64-msvc.node` |
| Windows ARM64 | `aarch64-pc-windows-msvc` | `kimi-native-tools.win32-arm64-msvc.node` |
| macOS ARM64 | `aarch64-apple-darwin` | `kimi-native-tools.darwin-arm64.node` |
| macOS x64 | `x86_64-apple-darwin` | `kimi-native-tools.darwin-x64.node` |
| Linux x64 | `x86_64-unknown-linux-gnu` | `kimi-native-tools.linux-x64-gnu.node` |
| Linux ARM64 | `aarch64-unknown-linux-gnu` | `kimi-native-tools.linux-arm64-gnu.node` |

Build each target with:

```bash
rustup target add <target-triple>
napi build --platform --release --target <target-triple>
```
