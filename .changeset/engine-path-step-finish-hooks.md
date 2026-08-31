---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Run the `onDidFinishStep` hook on the engine-override path. The external engine drives the whole turn in one call, so gates registered on that hook never fired while it was active — notably user-configured external hooks (`hooks[]`) and tool-dedupe bookkeeping, which have no other trigger point. The gate now runs once after the engine returns, mirroring the `onWillBeginStep` gate that already ran before it; verified by a control experiment against the pre-fix code. Full/micro compaction is unaffected — its pre-step gate (`onWillBeginStep`) already covered the engine path. Also declares the `drainSteers` engine-input callback the Rust loop already consumes (host wiring still pending) and guards a nullable native module in `initTracing`.
