---
'@moonshot-ai/kimi-code': patch
---

Agent and AgentSwarm subagents on the ACP and standalone server paths honor the configured [secondary_model] pool, and a model request without a configured pool reports an actionable error instead of failing in the host.
