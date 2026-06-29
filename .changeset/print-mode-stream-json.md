---
"@moonshot-ai/kimi-code": patch
---

Expand `kimi -p` print mode: add `--input-format text|stream-json` (multi-turn prompts over stdin), `--final-message-only`, and the `--quiet` shorthand. In `stream-json` mode the output is now entirely JSON and covers the full activity stream — model thinking, tool progress, notifications, subagent and lifecycle events, and turn errors (retryable provider errors map to exit code 75). Background tasks are drained before exit, gated by `background.keepAliveOnExit`.
