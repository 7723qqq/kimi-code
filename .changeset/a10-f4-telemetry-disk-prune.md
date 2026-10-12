---
"@moonshot-ai/agent-core-v2": patch
---

Bound the on-disk growth of failed telemetry batches by pruning them from the periodic flush (a10/F4 of the 2026-10-12 audit).

Every failed telemetry batch is persisted as its own `<homeDir>/telemetry/failed_<timestamp>_<random>.jsonl` file. Deletion only ever happened inside `CloudTransport.retryDiskEvents` (files older than `DISK_EVENT_MAX_AGE_MS`, corrupt JSONL, or batches that resend successfully), and that method had no production caller in `agent-core-v2`: `kap-server` only calls `flush`/`shutdown` plus `startPeriodicFlush`, so a long-running `kimi web` daemon had no cleanup path at all. An offline or rate-limited user accumulated one file per failed batch indefinitely.

- The expiry and corruption checks moved into a new `pruneExpiredDiskEvents()` entry point, which is the single place that deletes stale batches. `retryDiskEvents()` now calls it first and then resends what remains, so its semantics are unchanged.
- A hard ceiling backs up the 7-day window: at most `DISK_EVENT_MAX_FILES` (500) files or `DISK_EVENT_MAX_BYTES` (50 MB) are kept, oldest first, both overridable per transport.
- `CloudAppender.startPeriodicFlush()` prunes once at startup and then every 20 ticks of the existing 30 s flush interval; `CloudAppender.pruneDiskEvents()` exposes the same operation explicitly. Pruning is best-effort and never affects `flush()` or `shutdown()`.

Not changed here: failed batches are still only *resent* by an explicit `retryDiskEvents()` call, so the new periodic path deletes expired batches without re-uploading them. Adding automatic resend would change reporting semantics (and risk duplicate uploads) and belongs in its own change.
