---
'@moonshot-ai/kimi-code': patch
---

Advertise the background-wait tool as `WaitFor` instead of the REPL-only `TaskWait`, so the TUI's call card matches, goal mode points at a tool the model is actually offered, and subagent profiles that allowlist `WaitFor` can grant it.
