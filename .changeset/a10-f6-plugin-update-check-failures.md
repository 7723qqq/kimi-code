---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/klient": patch
---

Report a plugin whose update check failed instead of dropping it from the result (a10/F6 of the 2026-10-12 audit).

`PluginManager.checkUpdates` mapped every GitHub-backed plugin through a `try` whose `catch { return undefined; }` was followed by `.filter((result) => result !== undefined)`, so a plugin whose lookup threw — offline, rate-limited, repository deleted — simply vanished from the array. A consumer had no way to tell that plugin apart from one that was not installed, and the entries that did come back carried `updateAvailable: false` for both "already current" and "never got an answer"; the manager had no logger either, so nothing recorded the failure.

- A failed check now keeps its plugin in the result as `PluginUpdateStatus` with `checkFailed: true`, a non-empty `errorMessage`, and `current`/`latest`/`displayVersion` carrying the plugin's own installed ref; `updateAvailable` stays `false`. Both new fields are optional, so a consumer that only reads `updateAvailable` sees the same shape as before.
- `PluginManager` accepts an optional `ILogService` (passed by `PluginService` from DI) and logs `plugin update check failed` with the plugin id and the error, so a silent failure is now recoverable from logs as well.
- The `klient` wire schema `pluginUpdateStatusSchema` mirrors both fields; without it zod's strip semantics would have discarded them at the RPC boundary.
