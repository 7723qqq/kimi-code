---
'@moonshot-ai/kimi-code': patch
---

Advertise the background-wait tool as `WaitFor` instead of `TaskWait`. The main session tool table was publishing the REPL-only `TaskWait` name, so the TUI's `WaitFor` renderer never matched the call card, the `WaitFor` guidance in goal mode pointed at a name the model was not offered, and subagent profiles that allowlist `WaitFor` could not grant it. `WaitFor` is now the advertised product name; the REPL keeps its `TaskWait` alias.
