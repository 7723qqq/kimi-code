---
'@moonshot-ai/kimi-code': patch
---

Fix project-level mcp.json discovery and harden MCP server connections: strip the configured `Authorization` header from cross-origin SSE endpoint events and redirects, cap tool result size, and read a tampered or truncated OAuth credential envelope as "no credentials" instead of panicking.

Two hardening measures this entry previously claimed are **not** in the engine and are dropped rather than shipped as a promise: stdio MCP children are still spawned with the full inherited parent environment plus the configured `env` map (no allowlist, no `env_clear`), and the OAuth flow has no `state` validation. The address guard that does exist is origin-based, not an internal/private-address filter.
