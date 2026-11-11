---
"@moonshot-ai/agent-core-v2": patch
---

Serialize operation log view captures across processes with a stale-aware, heartbeat-protected capture lock, and isolate each repository view service's shadow index so concurrent agents and processes cannot corrupt one another's index.
