Execute a Windows PowerShell script natively (PowerShell 7 `pwsh` when available, otherwise Windows PowerShell 5.1). The script runs as a direct PowerShell process — it is not routed through bash.

**When to use this instead of Bash:**

- The task is inherently PowerShell: Windows registry, services, scheduled tasks, winget, WinGet/MSI installs, COM/WinRM, Windows event logs, NTFS ACLs, certificate store.
- You need PowerShell cmdlets or .NET types (`Get-Service`, `Get-ItemProperty`, `[System.*]`).
- You are on Windows and about to run `powershell.exe` / `pwsh` from the Bash tool — do not: the bash→native-PowerShell bridge re-encodes output and corrupts non-ASCII text. Use this tool instead; output is always decoded as UTF-8.

**When to keep using Bash:** anything with POSIX shell semantics — pipes over coreutils, git, package managers of the project, build/test runners. File reads/edits/searches belong to `Read` / `Edit` / `Glob` / `Grep` regardless of platform.

**Behavior:**

- The script is passed as a single `-EncodedCommand` payload, so quoting and encoding are handled for you; write ordinary PowerShell script text. Interactive input is not supported.
- The session runs with `-NoProfile -NonInteractive`. Output encoding is pinned to UTF-8, so non-ASCII text (including Chinese) comes back clean.
- stdout and stderr are combined and returned as a string. The output may be truncated if it is too long. A non-zero exit ends the result with a `Command failed with exit code: N` line; a script killed by its timeout or interrupted by the user ends with its own message instead.
- Each call runs in a fresh process: variables and location do not persist between calls. To run in a particular directory, pass the `cwd` argument.
- Foreground calls default to ${DEFAULT_TIMEOUT_S}s and allow up to ${MAX_TIMEOUT_S}s; a foreground call that hits its timeout is moved to the background instead of being killed.

If `run_in_background=true`, the script will be started as a background task and this tool will return a task ID instead of waiting for completion. When doing that, you must provide a short `description`. Background commands default to ${DEFAULT_BACKGROUND_TIMEOUT_S}s timeout and `timeout` is capped at ${MAX_BACKGROUND_TIMEOUT_S}s; set `disable_timeout=true` only when the task should run without a timeout. You will be automatically notified when the task completes. After starting one, default to returning control to the user instead of immediately waiting on it. Use `TaskOutput` only for a non-blocking status/output snapshot — do not wait on a task you just launched. Use `TaskStop` only if the task must be cancelled. If a human user wants to inspect background tasks themselves, point them to the background-task panel.

**Safety:** do not use this tool to escape the working directory, to modify files outside of it unless instructed, or to run commands that require superuser privileges unless explicitly instructed.
