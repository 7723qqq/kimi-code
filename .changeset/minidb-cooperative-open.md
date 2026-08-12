---
"@moonshot-ai/minidb": patch
---

Make the open path cooperative: WAL replay, index image loading, and bulk store fills now yield to the event loop in bounded slices instead of blocking, with a `bulkLoading` guard against expiry races and a process-wide bounded text-build worker slot. Open lifecycle telemetry is exposed through `LifecycleTracker`, and cancellation is no longer swallowed into a full index rebuild.
