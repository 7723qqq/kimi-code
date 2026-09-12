---
'@moonshotai/kimi-code': patch
---

Fix the pure-native engine path (`KimiEngine`), which advertised capabilities it could not execute: it now takes an optional MCP manager, a local state store and user hooks, installs a subagent roster so `Agent`/`AgentSwarm` are not dead entries, serves the state bridge (todo/plan/goal) and `host/goal` from the local store instead of a host that does not exist, advertises the callbacks layer's aggregate tool table instead of only the core file tools, and installs the blind-write (stale) guard that the other entry points have.
