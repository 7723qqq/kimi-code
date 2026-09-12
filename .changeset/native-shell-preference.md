---
'@moonshot-ai/kimi-code': minor
---

Port native Windows shell selection into the Rust engine. A new `[shell]` config section (`preference`, one of `auto` / `bash` / `powershell` / `pwsh` / `cmd`) pins the command interpreter the `Bash` tool runs under, and the Rust engine now auto-detects on Windows in the same order the retired TS engine did — PowerShell 7 (`pwsh`) → Windows PowerShell → Git Bash → `cmd` — instead of always forcing Git Bash. `KIMI_SHELL_PATH` still takes priority over `preference`. The Bash tool builds the flavor-specific exec prefix (`-c`, `/c`, or `-NoProfile -NonInteractive -Command`), and the ACP / `--serve` standalone paths resolve the preference from `config.toml`. The SDK config schema gains the matching `shell` section.
