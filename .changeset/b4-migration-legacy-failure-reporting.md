---
"@moonshot-ai/migration-legacy": patch
"@moonshot-ai/kimi-code": patch
---

Report the legacy subagent and plan files a migration could not copy, instead of leaving the session silently incomplete.

A legacy subagent whose `meta.json` or `context.jsonl` could not be read, or whose wire could not be written, was skipped with no trace: the session migrated without that subagent while its main history still referenced it. A single unreadable plan file aborted the whole run after the other steps had already written their output, so neither the report nor the completion marker was written. Each subagent failure now appears in the migration report (`sessions.subagentFailures`) and in `migration-errors.log`; each plan-file failure appears in `plans.failures` and the log while the remaining files are still copied. An empty subagent directory is still skipped silently, and the plans step still fails when every file fails.
