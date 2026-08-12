---
'@moonshot-ai/kimi-code': patch
'@moonshot-ai/agent-core-v2': patch
---

Upgrade MCP client from `@modelcontextprotocol/sdk` 1.29.0 to the v2 package family (`@modelcontextprotocol/client` / `@modelcontextprotocol/core` 2.0.0). Protocol negotiation stays on the legacy 2025-11-25 handshake by default, so existing MCP servers remain fully compatible; the 2026-07-28 protocol revision remains an opt-in for a future change.
