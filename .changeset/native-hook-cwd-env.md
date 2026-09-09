---
"@moonshot-ai/kimi-code": patch
---

Lifecycle hooks accept per-rule `cwd` (working directory, defaults to the session project directory) and `env` (extra environment variables merged over inheritance); dedup of identical commands now accounts for the working directory.
