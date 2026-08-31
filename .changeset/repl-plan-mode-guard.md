---
"@moonshot-ai/kimi-code": patch
---

Enforce plan-mode write restrictions in the standalone Rust REPL. The REPL's `EnterPlanMode`/`ExitPlanMode` tools toggled the plan state but nothing stopped the model from editing arbitrary files while plan mode was active — v2's `AgentPlanService.guardToolExecution` vetoes any Write/Edit that does not target the current plan file and denies TaskStop outright. `NativeToolCallbacks` now carries an optional `plan_guard` (wired only in the REPL): when plan mode is active, Write/Edit must resolve to the plan file path (absolute or workspace-relative) and TaskStop is denied, with the v2 denial messages. `cargo test --lib` 765 passed, clippy 0 warnings, fmt clean.
