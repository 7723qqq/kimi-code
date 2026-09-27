---
"@moonshot-ai/kimi-code": patch
---

Align the DangerousCommandAsk policy with upstream: auto and yolo no longer stop for high-risk shell commands, a `[permission] dangerousCommandGuard: false` switch disables the policy entirely, and Write/Edit no longer re-resolve paths through symlinks before the sandbox check.
