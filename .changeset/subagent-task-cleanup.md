---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
"kimi-code-app": patch
---

Stop a subagent's own running tasks when its run settles. Backgrounded Bash commands and other child processes started by a subagent no longer outlive the subagent when it completes, fails, or is stopped.
