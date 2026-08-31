---
"@moonshot-ai/kimi-code": patch
---

Accumulate goal usage across turns in the standalone Rust REPL and show the goal in `/status`. The REPL previously read the stored goal into `run_turn`'s `GoalContext` (budget checks and steering) but never wrote usage back, so `turns_used` / `tokens_used` stayed at zero and token budgets only ever saw the current turn's tokens. `StateStore::goal_record_usage` now folds each finished turn into the stored goal (v2 `incrementGoalTurn` + `accountTokenUsage` semantics: `turns_used +1`, `tokens_used += output tokens`, active goals only), and `/status` renders the goal line (status, objective, turns/tokens used, turn budget). `cargo test --lib` 761 passed, clippy 0 warnings, fmt clean.
