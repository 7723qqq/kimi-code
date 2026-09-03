---
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/agent-core-v2": minor
---

Native tool executions now emit `tool_call` telemetry (outcome / duration_ms / error_type), closing the observability gap where engine-local executions were invisible on dashboards. The engine measures the native execution segment and reports over the existing `host/telemetry` channel with the exact v2 `ToolCallEvent` shape; `dup_type` is always `normal` since dedupe-supplied repeats never reach the execution layer, and `trace_id` remains a known gap (the engine cannot capture the provider request id).
