---
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-native-tools": patch
---

Windows: on first launch, prompt to install MSYS2 when no MSYS2 bash is detected, then switch the shell to it via `KIMI_SHELL_PATH` after install. Skipping or a successful install marks the prompt as shown; headless (`kimi -p`) prints an install hint on stderr on every run (not marked) until MSYS2 is installed or the TUI gate fires.

Also fixes MSYS2 bash commands failing with "command not found": MSYS2 (unlike Git Bash) does not prepend its own `/usr/bin` to the inherited Windows PATH in non-login mode, so the bash tool now prepends `/usr/local/bin:/usr/bin:/bin` to PATH for Windows bash invocations.

Shell detection on Windows now recognizes MSYS2 installs (`C:\msys64\usr\bin\bash.exe`) alongside Git for Windows, and the Windows system-prompt notes are generated from the detected shell (bash / PowerShell / cmd) instead of assuming Git Bash.
