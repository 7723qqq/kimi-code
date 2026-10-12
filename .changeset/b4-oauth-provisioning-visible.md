---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kap-server": patch
"@moonshot-ai/klient": patch
---

Report an OAuth login as failed when its provider never reached `config.toml`, instead of leaving the user on "login succeeded" (B4 of the 2026-10-12 audit, a10/F1).

`OAuthService.provisionAfterSuccess` logged a provisioning failure and then, in its `finally`, set the flow to `authenticated` regardless — so a `config.toml` that was read-only, full or tainted produced a "login succeeded" screen while `[providers.*]` was never written. A restart then asked the user to log in again, and the first symptom was an unrelated model or auth error.

- Provisioning now has to prove itself: after `providerService.set` the persisted `providers` section is read back and compared with the provider just submitted, and a provider that is absent or different raises `CONFIG_PERSIST_BLOCKED`. This closes the gap the read-back exists for — `providerService.set` resolves even when the config-persist listener failed, because `deliverAsync` hands listener rejections to `onUnexpectedError` instead of rejecting. The comparison is against the state read *before* the write, so "swallowed write" is distinguishable from "nothing to do".
- A provisioning failure now sets a terminal `failed` status with the error in `error_message`, and only a flow still `pending` is finalised as `authenticated`. The already-authenticated fast path rejects instead of resolving with a success shape.
- `OAuthFlowStatus` gains `failed` (`agent-core-v2` `oauthProtocol.ts` and the `klient` wire schema that mirrors it), and the `oauth_login_finished` telemetry event accepts it.
- `kap-server` maps `CONFIG_PERSIST_BLOCKED` to `PERSISTENCE_FAILURE`, so the flow's failure reaches an API caller as a 5xx rather than a hollow success.
