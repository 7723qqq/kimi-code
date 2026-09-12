---

'@moonshotai/kimi-code': minor
---

The `[background]` print policy now actually runs on the native engine, for both the napi and stdio transports. In print mode (`kimi -p`), the engine holds the turn receipt while background tasks are still running: `print_background_mode = "exit"` keeps the old exit-after-one-turn behavior, `"drain"` waits for pending tasks without feeding results back, and `"steer"` (the default) additionally feeds task completions back to the main agent as follow-up turns, bounded by `print_wait_ceiling_s` and `print_max_turns`. Goal continuations run to completion on their own (previously the engine only reported `goal.continuation` and nothing re-prompted), and cron jobs scheduled during a print run now fire their turns inside the run instead of never. Hitting the ceiling or the turn budget emits a host-visible `warning` event instead of finishing silently.
