# node-sdk Agent Guide

The TypeScript SDK for the Kimi Code Agent (`@moonshot-ai/kimi-code-sdk`). Public surface: session lifecycle, prompt/turn streaming, context import/replay, file/mcp/capability types, and the v2 RPC client that talks to an in-memory v2 process. Consumed by `apps/kimi-code` and any other in-tree consumer that needs the engine's shape.

## M3 marker

This package is an **M3-marked v2 library consumer** (see root `ROADMAP.md` §M3, 2026-09-01, and `packages/agent-core-v2/AGENTS.md` §Library surface). The `agent-core-v2` dependency is intentional and load-bearing:

- **Wire-types re-export** (the bulk of the 39 unique import sites):
  `Event2` / `ContextMessage` / `CompactionResult` / `AgentReplayRecord` / `AgentContextData` / `TurnEngine` / `SwarmModeTrigger` / `AgentCommandInfo` / `CapabilityStatus` / `McpServerEntry` / `McpServerLocator` / `McpServerInspection` (as `AppMcpServerInspection`) / `FileMeta` — re-exported from `src/index.ts` / `src/types.ts` so SDK consumers get the engine's shapes directly.
- **Runtime helpers**: `installGlobalProxyDispatcher` / `estimateTokensForMessages` / `resolveGlobalLogPath` / `resolveLoggingConfig` / `parseAgentFileText` / `resolveAgentPath` / `PRIMARY_SUBAGENT_MODEL_CHOICE` — thin wrappers around v2 utilities that downstream consumers wouldn't reach directly.
- **In-memory v2 RPC client** (`src/sdk-rpc-client-v2.ts`): uses `IEngineOverrideService` to call into a v2 process; this is the closest analogue to klient's `MemoryChannel` and is what node-sdk's `createKlient({ mode: 'in-process' })` boots.

The SDK does not host App/Workspace/Session/Agent DI tiers itself; it only projects engine shapes and offers an in-memory IPC. No Rust equivalent exists for the wire-type vocabulary today (the closest, `packages/kimi-agent/src/rpc/types.rs`, covers only the turn-event subset). New code that needs the engine's public types stays on `agent-core-v2` until M5; the M5 path removes the dependency together with the other three M3 consumers.

## Layout

- `src/index.ts` — public exports (session / prompt / turn / config / file / mcp facade surfaces)
- `src/types.ts` — wire-type re-exports + SDK-internal mapped types
- `src/session.ts` / `src/events.ts` / `src/slash.ts` — session/turn/event surface
- `src/sdk-rpc-client-v2.ts` — in-memory v2 RPC client
- `src/v2/{session-wiring,session-mapper,resume-replay,import-context,event-mapper}.ts` — v2 ↔ SDK surface translation
- `src/legacy/` — v1 surface (kept for the v1-only live-server e2e suites; see the kap-server M3 entry for the v1 wire)

## Testing

- `test/` — SDK conformance + per-method assertions. Skips without the napi addon; the addon lives in `packages/kimi-agent`.
