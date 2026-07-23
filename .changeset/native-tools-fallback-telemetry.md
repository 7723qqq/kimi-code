---
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kimi-code-sdk": patch
---

Track when the Rust native tools fall back to the TypeScript implementation and surface the reason. Each `tryNative*` call now records a `native_tool_fallback` telemetry event with a `tool` and one of `disabled | load_failed | function_missing | function_threw`; the same `(tool, reason)` pair is logged once via `console.warn` so broken native binaries are visible without log spam. Wire the agent telemetry client at boot via `setNativeTelemetry(client)` (defaults to a no-op); the SDK wires it automatically inside `SDKRpcClient` from the harness's `telemetry` option, so app code does not need to change. The internal loader is now an explicit four-state machine (`unloaded | disabled | load_failed | loaded`) instead of the prior tri-state cache, so the two failure modes — flag off vs. binary missing/ABI mismatch — are distinguishable in telemetry.