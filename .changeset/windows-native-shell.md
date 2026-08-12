---
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/agent-core-v2": minor
"@moonshot-ai/kimi-native-tools": minor
"@moonshot-ai/kimi-code-sdk": patch
"@moonshot-ai/kap-server": patch
---

Windows native shell support: PowerShell 7 / Windows PowerShell / cmd are now detected and used by the Bash tool instead of forcing Git Bash. Detection order is `KIMI_SHELL_PATH` → pwsh → powershell → Git Bash → cmd, with a new `[shell] preference` config section (`auto | bash | powershell | pwsh | cmd`) to pin a shell explicitly. The Rust native bash engine mirrors the same detection. The Bash tool renders shell-specific semantics (PowerShell `$env:`/`$null`/`Get-ChildItem`, cmd `%VAR%`/`dir`, bash POSIX) into the model prompt, rewrites `nul` redirects per shell, and spawns PowerShell with `-NoProfile -NonInteractive`. Also fixes: `windowsVerbatimArguments` for cmd.exe spawns, PowerShell 5.1 `&&` guidance, and completes i18n coverage for user-facing errors across agent-core-v2, kap-server, node-sdk, and the kimi-code CLI.
