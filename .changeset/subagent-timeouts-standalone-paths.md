---
'@moonshot-ai/kimi-code': patch
---

Apply [subagent].timeout_ms and [swarm].timeout_ms (with their KIMI_SUBAGENT_TIMEOUT_MS / KIMI_CODE_SWARM_TIMEOUT_MS overrides) to ACP, standalone server and REPL sessions instead of always running the built-in 2-hour default.
