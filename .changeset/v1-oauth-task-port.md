---
"@moonshot-ai/kimi-code": patch
---

Port the remaining v1 OAuth token lifecycle and task-output drain into the v2 engine:

- `McpOAuthService` regains single-flight `refresh()` and proactive refresh timers (`sweepProactiveRefresh` / `stopProactiveRefresh` / `shutdown`), re-armed from a `-meta.json` sidecar written alongside stored tokens; `McpOAuthStore` gains a `list()` capability (encrypted credentials store included).
- `McpOAuthClientProvider` persists tokens through `OAuthTokenTransaction`, serializing refresh-grant writes per credential so concurrent 401 refreshes cannot race a rotating refresh token; the HTTP/SSE clients now ride the transaction-wrapped fetch.
- Interactive authorization flows are serialized per credential: concurrent `beginAuthorization` calls join the shared flow instead of clobbering PKCE/redirect state.
- Credential events (`tokens-saved` / `tokens-invalidated` / `refresh-failed`) are emitted from the service and routed through the App-scope `McpOAuthCoordinator`: workspaces reconnect `needs-auth`/`failed` servers on login and flip live connections back to `needs-auth` on invalidation (`tokenState` also reports absolute `expiresAt`).
- `AgentTaskService` awaits queued output appends before settling and exposes `drainWrites()`, called on session close so `output.log` tails survive.