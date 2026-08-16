---
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/agent-core-v2": minor
"@moonshot-ai/kimi-native-tools": minor
"@moonshot-ai/kimi-code-sdk": patch
"@moonshot-ai/kap-server": patch
---

Windows native shell support: PowerShell 7 / Windows PowerShell are now detected and used by the Bash tool before Git Bash. `KIMI_SHELL_PATH` and a new `[shell] preference` config section (`auto | bash | powershell | pwsh | cmd`) can pin bash, pwsh, powershell, or cmd explicitly. The Rust native bash engine mirrors the same detection. The Bash tool renders shell-specific semantics (PowerShell `$env:`/`$null`/`Get-ChildItem`, cmd `%VAR%`/`dir`, bash POSIX) into the model prompt, rewrites `nul` redirects per shell, and spawns PowerShell with `-NoProfile -NonInteractive`. Also fixes: `windowsVerbatimArguments` for cmd.exe spawns, PowerShell 5.1 `&&` guidance, and completes i18n coverage for user-facing errors across agent-core-v2, kap-server, node-sdk, and the kimi-code CLI.
