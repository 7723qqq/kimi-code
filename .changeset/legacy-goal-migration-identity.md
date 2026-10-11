---
"@moonshot-ai/kimi-code": patch
---

Keep a goal's identity when reading a session written by an older version. The 1.3 → 1.4 wire migration dropped `goalId` from `goal.update` and `goal.clear` records and never added the `agentId` the current schemas require, so those records failed validation on replay and were skipped — a goal from an old session could come back with its completion signal missing.
