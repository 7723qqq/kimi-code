---
"@moonshot-ai/kimi-code": patch
---

Implement the remote environment probe for the SSH execution environment: `osEnv` is now populated during creation (best-effort `uname` + shell detection) instead of throwing.
