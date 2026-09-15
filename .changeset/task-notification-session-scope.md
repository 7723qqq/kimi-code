---
"@moonshot-ai/kimi-code": patch
---

Fix a print-mode (`kimi -p`) cross-session leak in the native engine: the background task runner is shared by every session in the process, so a session's settle could drain another session's task-completion notification and turn it into its own follow-up turn. Task notifications now carry the session that spawned the task, and the print settle drains only its own session's completions; a task spawned without a session id is server-level and is never handed to a session.
