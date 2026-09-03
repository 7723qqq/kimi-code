---
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/agent-core-v2": minor
---

Live output streaming for native bash (the `tool.progress` mirror, closing the last engine-side behavior gap from the P23 equivalence audit): native bash now streams its stdout/stderr chunks to the host as they are written instead of returning everything at once, and the host dispatches them as the same `tool.progress` Event2 events the host-side path uses — so TUI/web progress cards stay live while long native commands run. Fire-and-forget over the existing `emit_event` channel; 8 KiB chunk granularity with stdout/stderr kinds.
