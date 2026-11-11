---
"@moonshot-ai/kimi-code": patch
---

Default the TUI to fullscreen mode instead of regular mode when `KIMI_CODE_EXPERIMENTAL_FLAG=1` is set. `tui_mode` is no longer written to `tui.toml` unless you explicitly pick a mode, so unrelated preference saves never persist it. When fullscreen is requested but the terminal cannot support it (tmux control mode, Termux, or a dumb terminal), the CLI falls back to regular mode and explains why; `KIMI_CODE_TUI_FULL_SCREEN` still overrides the saved preference.