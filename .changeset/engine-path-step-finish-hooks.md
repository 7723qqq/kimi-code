---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Run the `onDidFinishStep` hook on the engine-override path. The external engine drives the whole turn in one call, so the step-finish gates registered on that hook (full/micro compaction checks, step-retry bookkeeping, tool dedupe, external hooks, goal outcome continuation) never fired while it was active — notably, session-level auto-compaction never triggered, letting the context grow unbounded across turns. The gate now runs once after the engine returns, mirroring the `onWillBeginStep` gate that already ran before it. Also declares the `drainSteers` engine-input callback the Rust loop already consumes (host wiring still pending) and guards a nullable native module in `initTracing`.
