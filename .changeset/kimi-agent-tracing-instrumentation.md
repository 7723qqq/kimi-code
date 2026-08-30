---
"@moonshot-ai/kimi-code": patch
---

Add optional `tracing` instrumentation to `packages/kimi-agent` (A.1 — performance profile infrastructure). The change is opt-in: nothing happens unless the host sets `KIMI_AGENT_TRACE=1` (text format to stderr) or `KIMI_AGENT_TRACE_FORMAT=json` (JSON for chrome://tracing / speedscope.app visualisation). Default behaviour is unchanged, so this is purely additive observability.

Five hot-path entry points now carry `#[tracing::instrument]` spans with minimal field captures:
- `run_turn` (turn_loop) — `turn_id`, `max_steps`, `has_goal`
- `MultiLLM::first_past_the_post` — `providers`
- `MultiLLM::all_results` — `providers`
- `race_first_success` — `handles`
- `schedule_tool_calls` / `execute_scheduled` (tool_scheduler) — `call_count` / `batch_size`

`main.rs` initialises the subscriber after the JSON-RPC server is wired up but before the first turn, so the wire protocol (`println!` in `rpc/server.rs`) is never touched. `cargo test --lib` and `bun x vitest run packages/kimi-agent` both pass with 253 + 57 tests, clippy 0 warnings. A subsequent commit will add a napi binding to let the vitest test harness activate tracing on demand.
