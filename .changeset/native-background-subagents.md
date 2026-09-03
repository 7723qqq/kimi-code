---
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/agent-core-v2": minor
---

Native background subagents: `Agent` calls with `run_in_background: true` now execute detached inside the Rust engine and return the v2 running shape immediately (task_id / agent_id / automatic_notification / next_step / resume_hint). The engine reports completion over the `subagent.completed` / `subagent.failed` lifecycle events, and the host bridges the outcome into its task system (`NativeBackgroundAgentTask`, kind `agent`, detached) so the settle → notification → synthetic-turn delivery path is identical to host-spawned background agents. Resume on the completed conversation works through the native resume path. `fork` and call-level `model` overrides remain host-owned.
