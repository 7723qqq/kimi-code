---
'@moonshot-ai/kimi-code': patch
---

Subagents spawned by Agent and AgentSwarm honor the configured `[secondary_model]` model pool on every entry point (native, ACP and the standalone server), the pool is enabled by default, and a model request without a configured pool now reports an actionable error.
