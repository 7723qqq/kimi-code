---
"@moonshot-ai/kimi-native-tools": patch
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kimi-code": patch
---

Move native bash, grep, and structured grep execution to a background thread pool to avoid blocking the Node event loop, add an experimental flag for microtask-scheduled in-process RPC, remove redundant session-existence checks before prompt/skill/message operations, and parallelize per-agent state queries during session resume.
