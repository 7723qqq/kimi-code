# @moonshot-ai/kimi-agent

High-performance Rust agent engine for Kimi Code CLI, designed to progressively replace `packages/agent-core-v2`.

See [ROADMAP.md](./ROADMAP.md) for the active migration roadmap, milestones, architectural invariants, and phased transition plan.

## Architecture Overview

```
packages/kimi-agent/src/
  turn_loop/          — Multi-step turn execution loop, goal budget checks, cancellation, and tool scheduling
  tools/              — Native tools (Read, Write, Edit, Grep, Glob, Bash, Fetch URL, Knowledge)
  llm/                — Native LLM direct wire transports (OpenAI, Anthropic, Gemini) & streaming
  server/             — Native HTTP/1.1 REST router, RFC 6455 WebSocket streaming, and EventHub fan-out
  session/            — In-memory and SQLite session store persistence
  events/             — Typed EngineEvent definitions and EventBus subscription hub
  permission/         — Native 12-policy permission evaluation pipeline
  compaction/         — Message compaction and context window management
  napi_bindings.rs    — Node.js / Bun NAPI bindings (EngineSessionHandle)
  main.rs / repl/     — Standalone CLI / REPL mode (`--features cli`)
```

### Key Subsystems

- **Turn Loop (`src/turn_loop/`)**:
  - Multi-step execution loop with goal budget tracking (turn count, token usage, wall-clock duration).
  - Fine-grained cancellation via atomic signals on step boundaries.
  - Jittered exponential backoff retry system (`retry.rs`).
  - Concurrent tool scheduling (`tool_scheduler.rs`) with access conflict detection for serialized conflicting writes and parallel reads.
- **Native Tools & Sandboxing (`src/tools/`)**:
  - Native filesystem tools: `Read`, `Write`, `Edit`, `Grep`, `Glob` constrained to workspace roots.
  - Process execution: Sandboxed `Bash` execution with stream callbacks, process tree termination, and timeout handling.
  - Extended capabilities: `fetch_url` (with manual per-hop redirect validation and SSRF protection), `knowledge_tool` (SQLite FTS), `skill`, `agent_tool`, `agent_swarm`, `wait_for`, and `Tower*` (11 native coordination tools).
- **LLM Transport Layer (`src/llm/`)**:
  - Native HTTP/SSE transport for direct provider connections (OpenAI, Anthropic, Google Gemini).
  - Multi-LLM racing / fallback execution (`multi.rs`).
  - Streaming accumulators with usage accounting, custom header propagation, and thinking budget support.
- **Server & WebSocket Transport (`src/server/`)**:
  - Native HTTP/1.1 REST router handling `/api/v1` session management (`http.rs`, `router.rs`).
  - RFC 6455 WebSocket framing layer (`ws.rs`) with zero external crates (self-contained SHA-1 handshake digest, mask validation, close code validation).
  - Event distribution hub (`hub.rs` / `EventHub`): Synchronous bus fan-out to bounded per-connection subscriber queues with backpressure disconnection policy (1013 Close).
- **Session & Storage (`src/session/`)**:
  - In-memory and SQLite-backed session persistence (`sqlite_store.rs`).

## Development & Testing

```bash
# Type check all targets
cargo check --all-targets

# Run unit tests
cargo test --lib

# Run server module tests
cargo test --lib server::

# Run with standalone CLI features enabled
cargo test --features cli

# Lint with Clippy
cargo clippy --all-targets

# Format check
cargo fmt -- --check
```
