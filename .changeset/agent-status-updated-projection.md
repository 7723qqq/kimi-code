---
'@moonshot-ai/kimi-code': patch
---

Emit `agent.status.updated` — the multi-source status snapshot the Web client's status bar folds (model, thinkingEffort, permission, planMode, contextTokens, camelCase payload per the projector contract). The engine publishes it on every turn boundary (after the turn is durable, so the context growth is visible) and the session profile route refreshes it after agent_config writes; a byte-identical snapshot is deduped per session like kap-server's broadcaster.
