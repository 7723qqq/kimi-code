---
'@moonshot-ai/kimi-code': patch
---

Pin the WebSocket event vocabulary on both sides. A golden `ws-event-contract.json` now records the concrete event names the kimi-web wire union and the protocol `AgentEvent` union define, plus the subset the native server emits; the Rust server (`SERVER_WEB_EVENT_TYPES`), the kimi-web client (`WIRE_EVENT_TYPES`), and the protocol schema each assert against it, so a rename on either side fails a test instead of silently dropping UI updates.
