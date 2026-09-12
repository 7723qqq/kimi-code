---
'@moonshotai/kimi-code': patch
---

Align the agent's subagent-timeout and session-lifecycle-hook semantics with v2: an explicit `timeout_ms = 0` now means "no timeout" for `Agent` and `AgentSwarm` (v2 `taskService` arms the timer only when `timeoutMs > 0`), `SessionStart` / `SessionEnd` hooks fire observationally on the REPL (startup/resume/new/exit) and the standalone server (session create/delete) with source/reason matchers, and every observe-only hook payload now carries the v2 `hook_event_name` field. `select_tools` joins the native tool-name contract so the dedup guard and `handles()` agree with its native execution arm.
