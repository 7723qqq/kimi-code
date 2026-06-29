---
"@moonshot-ai/kimi-code": patch
---

Expand `kimi -p` print mode to cover (and slightly exceed) kimi-cli's non-interactive `stream-json` capabilities: emit model thinking as its own JSONL line; add `--input-format text|stream-json` (multi-turn prompts over stdin), `--final-message-only` and the `--quiet` shorthand; surface background-task/cron events as `notification` lines; report turn failures as `{"type":"error",...}` JSON with retryable provider errors mapped to exit code 75; wait for background tasks before exit (gated by `background.keepAliveOnExit`); and emit the TUI activity layer (tool progress, subagent lifecycle, warnings, skill/MCP/compaction/goal/agent-status/tool-list updates) on stdout so the stream-json output stays both complete and entirely JSON.
