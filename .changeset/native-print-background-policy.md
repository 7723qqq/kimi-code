---
'@moonshot-ai/kimi-code': minor
---

Make the `[background]` print policy work on the native engine. In print mode (`kimi -p`) the engine now holds the turn receipt while background tasks run: `print_background_mode = "exit"` keeps the old behaviour, `"drain"` waits for pending tasks, and `"steer"` (the default) feeds task completions back to the agent as follow-up turns, bounded by `print_wait_ceiling_s` and `print_max_turns`. Cron jobs scheduled during a print run now fire inside the run, and hitting a ceiling emits a warning event instead of finishing silently.
