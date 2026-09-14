---
"@moonshot-ai/kimi-code": minor
---

Add a native `Lsp` tool to the Rust engine for go-to-definition, find-references, hover and document-symbol queries (`packages/kimi-agent/src/tools/lsp_tool.rs` + `packages/kimi-agent/src/native/lsp/`). The tool is advertised by `GET /api/v1/tools` and is listed in the engine's native tool names, so calls are dispatched natively instead of being forwarded to a host.

Language servers are auto-detected from the file extension and resolved from `PATH` against a fixed table — `typescript-language-server` (ts/tsx/js/jsx/mjs/cjs), `rust-analyzer` (rs) and `pyright` (py). There is no `[lsp]` config section: custom servers, custom binaries and additional languages are not configurable, and a server that is not on `PATH` makes the tool return an error.
