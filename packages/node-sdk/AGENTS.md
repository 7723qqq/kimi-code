# node-sdk Agent Guide

The TypeScript SDK for the Kimi Code Agent (`@moonshot-ai/kimi-code-sdk`). Public surface: session lifecycle, prompt/turn streaming, context import/replay, file/mcp/capability types, and the RPC client that talks to the Rust engine (packages/kimi-agent) through the native addon or stdio. Consumed by `apps/kimi-code` and any other in-tree consumer that needs the engine's shape.

## Engine decoupling

This package is **decoupled from `@moonshot-ai/agent-core-v2`** (the v2 engine is retired together with its M5 deletion):
- The public wire shapes (`ContextMessage` / `AgentReplayRecord` / `CompactionResult` / `GoalSnapshot` / MCP + file + capability types) are **frozen local types** in `src/types.ts` — they no longer re-export from the v2 engine.
- Shared wire / MCP-OAuth on-disk contracts (`WIRE_PROTOCOL_VERSION`, `mcpOAuthStoreKey`, …) live in **`@moonshot-ai/protocol`** (`src/wire.ts`) and are imported from there.
- The RPC client (`src/sdk-rpc-client-v2.ts` → `src/native/sdk-rpc-client-native.ts`) talks to the **Rust engine** directly; there is no in-memory v2 process anymore.
- The former `src/v2/` translation layer (session wiring / event mapping / wire replay) was removed; behavioral coverage moved to the native harness (`SDKRpcClientNative`).

The SDK does not host App/Workspace/Session/Agent DI tiers itself; it only projects engine shapes and offers the native IPC.

## Layout

- `src/index.ts` — public exports (session / prompt / turn / config / file / mcp facade surfaces)
- `src/types.ts` — frozen wire shapes + SDK-internal mapped types
- `src/session.ts` / `src/events.ts` / `src/slash.ts` — session/turn/event surface
- `src/sdk-rpc-client-v2.ts` — facade over the native Rust RPC client
- `src/native/sdk-rpc-client-native.ts` — native Rust engine client (napi addon / stdio)
- `src/legacy/` — v1 surface (kept for the v1-only live-server e2e suites; see the kap-server entry for the v1 wire)

## Testing

- `test/` — SDK conformance + per-method assertions. Skips without the napi addon; the addon lives in `packages/kimi-agent`.
