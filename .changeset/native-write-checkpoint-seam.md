---
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/agent-core-v2": minor
---

Native write executions now participate in file checkpoints (the last missing piece of host lifecycle equivalence, P25). A new `host/checkpoint` request seam fires twice per native Write/Edit: `prepare` before the engine writes (the host captures pre-images of the target files and the engine awaits the response, mirroring v2's `onWillExecuteTool`) and `record` after (post-image digests, so undo can detect manual edits, mirroring `onDidExecuteTool`). Write paths come from the same access inference the engine's tool scheduler uses for conflict detection. Both sides fail open — an unwired or failing host skips the snapshot, which is exactly the pre-change behavior — and the checkpoint/undo authority stays host-side. Subagent-native writes are not yet checkpointed (turn-tree attribution is undefined and deferred).
