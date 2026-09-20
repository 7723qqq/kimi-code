---
'@moonshot-ai/kimi-code': patch
---

Make `--agent` and `--agent-file` take effect. Both flags were parsed but silently dropped at session creation, so a named profile never reached the engine; agent files are now discovered across the documented scopes with the documented precedence, the profile shapes the session's system prompt, and an unknown name fails session creation naming the value instead of running the default agent.
