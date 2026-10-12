---
"@moonshot-ai/kimi-code-sdk": patch
"@moonshot-ai/kimi-code": patch
---

The SDK's diagnostic logger is configured again, and a failing log write stops duplicating lines and losing the last batch.

`log.*` calls from the SDK and from the CLI were silently dropped: the host-side root logger was never configured (only the engine's own DI sink was seeded), so the log file the startup-failure message points at stayed empty. Constructing a harness now configures it from `resolveLoggingConfig`, the CLI does the same before parsing arguments so pre-harness startup failures are recorded, and `configureDiagnosticLogging` is exported for embedders. `KIMI_LOG_LEVEL=off` and the rotating size/file limits still apply.

When a write failed mid-batch, the sink re-queued the whole batch, rewriting the chunks that had already reached the file, and a batch still pending at `close` disappeared with only a rate-limited stderr notice. Recovery now re-queues only the lines that never made it, and closing reports the entries it drops.
