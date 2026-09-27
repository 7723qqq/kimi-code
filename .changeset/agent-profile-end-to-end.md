---
'@moonshot-ai/kimi-code': patch
---

Make `--agent` and `--agent-file` take effect: a named profile now shapes the session's system prompt, agent files are discovered across the documented scopes, and an unknown name fails session creation instead of silently running the default agent.
