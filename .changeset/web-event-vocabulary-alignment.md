---
'@moonshot-ai/kimi-code': patch
---

Align the server's WebSocket event vocabulary with the kimi-web wire contract: interaction broadcasts are renamed and reshaped (`event.approval.requested` with `tool_input_display`, `event.approval.resolved`, `event.question.requested` with rendered options, `event.question.answered/dismissed`), native tool results now also publish `event.tool.progress` / `event.tool.output` / `event.tool.completed` aliases on the server lane, turns emit `event.session.usage_updated` with the token delta, and compaction emits `event.session.history_compacted`. The engine-internal names (`tool.native`, napi `host/event`) stay untouched for the TUI transcript contract.
