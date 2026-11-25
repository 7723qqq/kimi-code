---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
"kimi-code-app": patch
---

Wait for a subagent's own background tasks and loop unwinding before its run settles, and stop them when the parent cancels. A subagent's Bash/background work no longer outlives the turn or the TUI's stopped state.
