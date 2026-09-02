---
"@moonshot-ai/kimi-code": patch
---

Fix the native packaging pipeline: `stageStdioCli` was defined but never invoked, so packaged `kimi.exe` bundles were missing the Rust engine's stdio CLI (`kimi-agent-cli.exe`) next to the executable and the stdio JSON-RPC transport silently degraded to napi-only. The build now stages it (loudly logging if the cargo artifact is absent) and the native smoke check covers both executables.
