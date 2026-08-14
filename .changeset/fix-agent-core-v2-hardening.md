---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Fix agent-core-v2 hardening gaps: register the session-scoped `SubagentBackendService` (the Agent tool could not activate), restore `fetchImpl` injectability for connection-pinned fetches (SSRF tests no longer hit the network), settle `run_code` workers immediately on `process.exit`/port close and bound their heap, extend the sandbox write guard to Write/Edit/run_code, and enforce the subagent delegation-depth cap on swarm and persistent-subagent spawns. `UpdateGoal` also accepts the documented `active` status again.
