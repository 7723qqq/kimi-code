---
"@moonshot-ai/agent-core-v2": patch
---

Gate the operation log execution window on each tool's declared `repoMutation`. Read-only and coordination tools no longer hold the window or opportunistically import external repository changes; those imports now happen at the next mutating tool execution or at undo/list/restore time, so operation histories contain fewer import records.
