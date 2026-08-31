---
"@moonshot-ai/kimi-code": patch
---

Create the plan file on plan-mode entry in the standalone Rust REPL and make the REPL's host-tool fallback name the unavailable tool. Entering plan mode previously generated the plan id/path but never created the file — v2's `writeEmptyPlanFile` creates it at entry so the model can Read it before writing; the REPL now writes an empty file at the generated path. The `ReplDummyHostCallbacks.execute_tool` fallback (tools outside the native set, e.g. the GitHub family) previously answered a generic "not supported" error; it now names the tool and lists the available native set so the model does not retry. `cargo test --lib` 767 passed, clippy 0 warnings, fmt clean.
