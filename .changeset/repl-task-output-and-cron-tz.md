---
"@moonshot-ai/kimi-code": patch
---

Persist background-task output in the standalone Rust REPL and run its cron scheduler in the local timezone. Task output was previously kept only in memory (`TaskRunner`), so `TaskOutput` after a restart read no output; the runner now writes each settled task's output to `<state_dir>/tasks/<taskId>/output.log` (the v2 `tasks/<taskId>/output.log` layout) and `state_read` attaches the v2-shaped snapshot (`outputPath` / `outputSizeBytes` / `previewBytes` / `truncated` / `fullOutputAvailable` / `preview`, 32 KiB preview cap) to the task entry. The cron scheduler previously ran at UTC offset 0 because std has no timezone data; the REPL now passes `chrono::Local`'s current offset (v2 `getTimezoneOffset` semantics), so `0 9 * * *` fires at local 9am. `cargo test --lib` 759 passed, clippy 0 warnings, fmt clean.
