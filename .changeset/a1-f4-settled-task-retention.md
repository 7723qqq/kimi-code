---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Terminal background tasks no longer accumulate in memory for the life of the agent scope. Settling a task only flipped its status: the entry kept its ring buffer (up to 1 MiB of retained output per task) plus any unflushed `pendingOutput`, and nothing ever removed it, so a long session with many background Bash or sub-agent tasks grew linearly in task count while `TaskList` and the concurrency-limit check walked every historical task. A task that settles now trims its in-memory retained output to the last 64 KiB — only once its output has a copy on disk, never when persistence failed, since the ring buffer is then the only copy — and finished tasks are kept in FIFO order with a cap of 200 per agent. Past that cap the oldest finished task is dropped from the live map and kept as a ghost, so `TaskList`, `TaskOutput` and `TaskStop` still answer for its id and its persisted log stays readable, but its in-memory output preview is gone. Set `task.max_settled_tasks` to raise or lower the cap.
