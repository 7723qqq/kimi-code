---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Wire the subagent backend subsystem into the engine: the `[subagent_backend]` config section is now recognized, and the Agent tool gains an experimental `backend` parameter (flag `subagent_backends`) that runs a task on an external agent CLI (claude-code, codex, acp) — refused while `[sandbox] mode` is not `"off"`.
