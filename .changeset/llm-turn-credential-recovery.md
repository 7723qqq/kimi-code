---
"@moonshot-ai/agent-core-v2": patch
---

Refresh a recoverable LLM credential and retry a turn request once after a 401, so a revoked OAuth token does not fail the turn outright.
