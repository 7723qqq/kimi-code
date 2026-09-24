---
"@moonshot-ai/kimi-code": patch
---

Align the DangerousCommandAsk policy with upstream: auto and yolo no longer stop for high-risk shell commands (upstream reverted that defense in 2.1.1), a `[permission] dangerousCommandGuard: false` switch can now disable the policy entirely, and Write/Edit no longer re-resolve paths through symlinks before the sandbox check.
