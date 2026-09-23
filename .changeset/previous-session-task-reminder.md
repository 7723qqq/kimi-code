---
"@moonshot-ai/kimi-code": patch
---

Tell the model when background tasks from a previous session lost contact. Restarting while a background task was still running used to drop it silently — the task domain kept the entry as `running` with no process behind it and nothing ever said so, so the model could assume the work completed. On startup the engine now marks those entries `lost`, persists that, and injects a one-shot reminder naming each task (a lost subagent is offered as `Agent(resume=…)` to continue from its prior context). The reminder follows the engine's model-input wording and fires once per task.
