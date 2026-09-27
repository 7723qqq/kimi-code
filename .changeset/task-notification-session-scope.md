---
"@moonshot-ai/kimi-code": patch
---

Fix a print-mode (`kimi -p`) cross-session leak: a session's settle could drain another session's task-completion notification and turn it into its own follow-up turn. Task notifications now carry the session that spawned the task, and a task spawned without one is treated as server-level and never handed to a session.
