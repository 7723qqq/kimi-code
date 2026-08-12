---
"@moonshot-ai/kimi-code": patch
---

Harden async and resource-leak paths and complete i18n coverage: prevent unhandled rejections (goal promotion, telemetry config read, event-listener dispatch, MCP OAuth teardown), fix resource leaks (fs-watch teardown on pre-attach failure, uncached session close, queued-message and tasks-browser races, async-queue early-exit), switch goal-completion card detection to a structured flag, add background-agent phases (lost/killed/timed out) with zh/en locales, close a klient IPC token-validation gap, and skip no-op state writes.
