---
"@moonshot-ai/kimi-code": patch
---

Stop four sources of sustained CPU that ran longer than the work they belonged to.

**The task output viewer stops polling once the task settles** (`tui/controllers/tasks-browser.ts`). Its 1 s interval called `getBackgroundTaskOutput` without a `tail`, which the task service answers by reading the whole `output.log` and decoding it (`MAX_TASK_OUTPUT_BYTES` is 16 MiB) — and nothing checked the task's status, so a finished task was still re-read every second for as long as the viewer stayed open. The poll now clears itself on a non-`running` status instead of re-reading a log that cannot change.

**Print-mode shutdown cannot hang or spin on the quiesce loop** (`cli/v2/run-v2-print.ts`). The loop that drains prompt queues and freezes every agent had no deadline of its own: the caller's `raceWithTimeout` only bounded the caller, so a `settled()` that never resolved parked the iteration before it could sleep, and a producer that kept re-submitting kept it snapshotting every loop at 100 Hz. Both awaits are now bounded by one deadline, and the loop returns when it expires so the caller's existing timeout path is what ends the wait.

**The status strip parses its update once per frame, not twice** (`tui/components/chrome/notify-panel.ts`). `measureHeight` and the paint path each called `layoutBody`, which builds a fresh `Markdown` and renders it, so one `render()` parsed the same text twice. The rendered body is memoized on the entry text and width and shared by both passes.

**The staged-update wait has a deadline and hashes once per generation** (`cli/sub/update-download.ts`). The wait polled every 2 s with no bound — a holder alive but wedged keeps its lock fresh forever — and re-hashed the staged native binary (~180 MB) on every round. It now expires into the caller's existing "another update is already downloading" path after six hours, and caches a verified `{exeFileName, sha256, stagedAt}` identity so a healthy wait hashes once instead of once per poll. Verdicts that did not verify are deliberately still re-read each round, since the holder can repair that same generation in place.
