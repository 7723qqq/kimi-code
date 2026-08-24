---
"@moonshot-ai/kimi-code": minor
---

Bun is now the sole packaging engine: release binaries are compiled with `bun build --compile` on all six targets, the Node SEA build chain has been retired, and self-updates only accept Bun artifacts. Existing Node SEA installs stop receiving binary updates and should reinstall via the install script.
