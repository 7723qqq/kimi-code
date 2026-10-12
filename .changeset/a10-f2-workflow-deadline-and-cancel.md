---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Stop a runaway workflow script from freezing the process, and make cancellation real (a10/F2 of the 2026-10-12 audit).

A workflow script is model-written JavaScript, and two of its failure modes were unrecoverable. The `vm` timeout only covered the synchronous prefix before the script's first `await`, and it was set to the same 12-hour deadline as the run itself, so a tight loop like `while (true) {}` or a `while` loop with no macro-task yield held the event loop, made `Workflow({ operation: 'wait' | 'cancel' })` answer with fiction, and could only be ended by killing the process. `cancel()` had the second half of the problem: it aborted and then waited 100 ms before writing `cancelled` itself — the run kept spawning subagents behind a status that already claimed it had stopped.

- The synchronous prefix is capped on its own (`WORKFLOW_SYNC_PREFIX_LIMIT_MS`, 30 s) independently of the total deadline, so a CPU-bound loop becomes a reclaimable failure instead of an unkillable hang.
- The default deadline drops from 12 hours to 30 minutes, and `Workflow({ operation: 'run', …, deadline_ms })` lets a run ask for more (or less). A workflow that legitimately needs hours must now say so.
- The run's `AbortSignal` participates in the race, so aborting settles the promise immediately instead of waiting for a barrier that never comes.
- `WorkflowService.cancel` no longer pre-emptively writes `cancelled`: it waits for the run to settle, and if a script still has not stopped after a 5 s grace period it logs `workflow.cancel.script-still-running` and only then marks the entry, so the warning is truthful about a script that is still running.
- A run ended by its deadline is reported as `failed` with `Workflow script deadline exceeded`, not as `cancelled` — the signal reason distinguishes the two.

Not fixed here: a busy loop that yields to the microtask queue but never to a macro task (`while (true) { await null }`) still cannot be interrupted from the same thread; ending that case needs `node:worker_threads` plus `terminate()` in a follow-up.
