---
'@moonshot-ai/kimi-code': patch
---

Read the real cron registry in the SDK: `getCronTasks` now enumerates the workspace's scheduled jobs (with their post-jitter next fire time) instead of always answering an empty list.
