# acp-server Agent Guide

The Agent Client Protocol (ACP) stdio host. Wires `@moonshot-ai/agent-core-v2` (the DI × Scope agent engine) into an in-process ACP server via `bootstrap()` in `src/start.ts`; ACP method handlers in `src/server.ts` drive the engine through the klient facade.

## M3 marker

This package is an **M3-marked v2 library consumer** (see root `ROADMAP.md` §M3, 2026-09-01, and `packages/agent-core-v2/AGENTS.md` §Library surface). The `agent-core-v2` dependency is intentional: acp-server implements v2's `Runtime` / `RuntimeProviderAttachment` / `IHostProcessService` interfaces (`src/acp-terminal/`) and registers two scoped services (`IHostFileSystem` in `src/acp-fs/`, `IAcpConnection` App-scope). The wire-only surface (`ContentPart` / `ContextMessage` / `SkillSummary` / permission + question payloads) is roughly 12 of 13 import lines and moves to a shared schema package once Rust exposes equivalents. New code that needs a v2-only interface stays on `agent-core-v2` until M5.

## Layout

- `src/start.ts` — bootstrap + AcpServer construction
- `src/server.ts` — JSON-RPC method handlers (initialize / authenticate / session.*)
- `src/convert.ts` / `src/session.ts` / `src/replay.ts` — wire ↔ engine projection
- `src/modes.ts` / `src/approval.ts` / `src/question.ts` / `src/interaction-bridge.ts` — ACP ↔ v2 interaction runtime
- `src/slash.ts` — skill catalog → slash-command palette
- `src/acp-terminal/` — v2 `Runtime` implementation, `IHostProcessService` shadow
- `src/acp-fs/` — Session-scope `IHostFileSystem` shadow, `IAcpConnection` App-scope

## Testing

- `test/` — ACP protocol conformance + per-method assertions. Skips without the napi addon; the addon lives in `packages/kimi-agent`.
