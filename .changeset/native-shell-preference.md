---
'@moonshot-ai/kimi-code': minor
---

Add a `[shell]` config section (`preference`: `auto` / `bash` / `powershell` / `pwsh` / `cmd`) that pins the command interpreter the `Bash` tool runs under. On Windows, `auto` now detects PowerShell 7, then Windows PowerShell, then Git Bash, instead of always forcing Git Bash; `KIMI_SHELL_PATH` still takes priority.
