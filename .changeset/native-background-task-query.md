---
"@moonshot-ai/kimi-code": patch
---

Expose background-task query APIs from the native task runner (`backgroundTaskList` / `backgroundTaskOutput` / `backgroundTaskStop`, plus `POST /api/v1/tasks/:id/stop` reason support) and wire them through the SDK, including the stop `reason` recorded as the entry's `stopReason`.
