---
"@moonshot-ai/kimi-telemetry": patch
---

Stop a shutdown-aborted telemetry batch from being spooled twice. When the shutdown timeout hit an in-flight POST, the transport had already persisted the batch and still handed it back to the sink, so the same events were written to a second `failed_*.jsonl` and both copies were replayed on the next start (duplicate events). `AsyncTransport.send` now reports that path with an exported `TelemetryPersistedError` instead of the underlying `AbortError`, so a caller cannot mistake an already-persisted batch for one that still needs saving.
