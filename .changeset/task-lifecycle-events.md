---
'@moonshotai/kimi-code': patch
---

Close the task-lifecycle gap of the WebSocket event vocabulary: background tasks (subagents, bash) now carry their parent session and work kind, and the TaskRunner announces both vocabularies the Web client consumes — `event.task.created` / `background.task.started` on spawn and `event.task.completed` / `background.task.terminated` on settle — fan out to the task's session lane (or `global`), while `SubagentRuntime` threads the pipeline's session id so background subagents attribute their events correctly. `TaskStop` / `TaskOutput` coverage is unchanged; the runner was already the production path for background work.
