---
"@moonshot-ai/kimi-code": patch
---

Fix two locale keys that no locale defined, and translate the last hardcoded strings in the inspector. `kimi provider import` and the TUI provider flow both print a hint when a registry answers 401/403 without a configured key; the hint's key was missing from the locale files, so the raw key reached the user. The inspector's "No session selected." / "Loading session…" / audit-trail placeholder were never routed through `t()` at all. Adds a `t()` call-coverage assertion to the locale parity test so a renamed key with a stale call site fails locally instead of in CI.
