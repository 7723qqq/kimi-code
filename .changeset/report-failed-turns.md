---
"@moonshot-ai/kimi-code": patch
---

Report why a turn failed instead of ending it silently. A provider error (a rejected request, an unreachable endpoint, a bad key) used to leave the transcript with the user's message and no reply at all — the engine's `turn.ended` carried the reason as a bare string, which the TUI could not read, and the separate error event v2 dispatches alongside it was never emitted. The engine now sends a protocol `KimiErrorPayload` (with a classified code such as `provider.api_error` / `provider.auth_error` / `provider.rate_limit`), the TUI renders it, and engine-side turn warnings (media budget, MCP startup) reach the UI again.
