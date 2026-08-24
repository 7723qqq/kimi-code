# @moonshot-ai/kimi-native-tools

## 0.3.0

### Minor Changes

- [`91c9441`](https://github.com/MoonshotAI/kimi-code/commit/91c9441422c7193a52a6683a2f54279c8a5003e7) Thanks [@7723qqq](https://github.com/7723qqq)! - Make the Rust native engines the primary paths for Grep and Bash, with the TypeScript / ripgrep implementations demoted to fallbacks.

  - Grep: the full native grep engine (`nativeGrep`) now runs first; ripgrep remains the fallback when the native module is unavailable. Native output uses absolute paths so workspace-relative display stays correct. Multiline searches keep using ripgrep (the native engine does not implement cross-line matching).
  - Bash: a new native process-lifecycle API (`nativeBashSpawn` / `nativeBashWait` / `nativeBashKill` / `nativeBashDispose`) streams stdout/stderr in real time and kills the process tree on demand; the Bash tool spawns through it and falls back to the node-local spawn.
  - Observability: a new `grep_tool_native` telemetry event tracks native usage, and the `/status` report shows `Native tools: rust / js (fallback)` so users can see which implementation is active.

- [`ac153b1`](https://github.com/MoonshotAI/kimi-code/commit/ac153b1c959eed8e5aaa6e1530c3ad94268a5613) Thanks [@7723qqq](https://github.com/7723qqq)! - Windows native shell support: PowerShell 7 / Windows PowerShell are now detected and used by the Bash tool before Git Bash. `KIMI_SHELL_PATH` and a new `[shell] preference` config section (`auto | bash | powershell | pwsh | cmd`) can pin bash, pwsh, powershell, or cmd explicitly. The Rust native bash engine mirrors the same detection. The Bash tool renders shell-specific semantics (PowerShell `$env:`/`$null`/`Get-ChildItem`, cmd `%VAR%`/`dir`, bash POSIX) into the model prompt, rewrites `nul` redirects per shell, and spawns PowerShell with `-NoProfile -NonInteractive`. Also fixes: `windowsVerbatimArguments` for cmd.exe spawns, PowerShell 5.1 `&&` guidance, and completes i18n coverage for user-facing errors across agent-core-v2, kap-server, node-sdk, and the kimi-code CLI.

### Patch Changes

- [`f7d9641`](https://github.com/MoonshotAI/kimi-code/commit/f7d9641567bd493b6d9dd15bd58018daad7af1ff) Thanks [@7723qqq](https://github.com/7723qqq)! - Cache-correctness and prompt-cache-stability hardening:

  - `llmRequester`: run micro-compaction on the raw history **before** `shapeHistory` so the `keepRecentMessages` cutoff (an index into raw history) stays stable and tool results inside the kept tail are not truncated.
  - `profile`: freeze the additional-dirs listing in the system-prompt prefix (keyed on the dir list, so `/add-dir` rebuilds immediately) and coalesce overlapping `refreshSystemPrompt` triggers into a single run plus one queued follow-up.
  - `client-configs`: re-validate a cached config against the caller's schema on hit; a hit that no longer parses is treated as a miss.
  - `byteLruCache`: evict by byte cap even when a cache key grows in place.
  - `kimi-native-tools`: TOCTOU-guard the file-read cache by snapshotting `(mtime, size)` before the read and skipping the cache entry if the file changed in between.

- [`098d7bf`](https://github.com/MoonshotAI/kimi-code/commit/098d7bf1d08ff786fd62178cf7f85e2cbabd5997) Thanks [@7723qqq](https://github.com/7723qqq)! - Windows: on first launch, prompt to install MSYS2 when no MSYS2 bash is detected, then switch the shell to it via `KIMI_SHELL_PATH` after install. Skipping or a successful install marks the prompt as shown; headless (`kimi -p`) prints an install hint on stderr on every run (not marked) until MSYS2 is installed or the TUI gate fires.

  Also fixes MSYS2 bash commands failing with "command not found": MSYS2 (unlike Git Bash) does not prepend its own `/usr/bin` to the inherited Windows PATH in non-login mode, so the bash tool now prepends `/usr/local/bin:/usr/bin:/bin` to PATH for Windows bash invocations.

  Shell detection on Windows now recognizes MSYS2 installs (`C:\msys64\usr\bin\bash.exe`) alongside Git for Windows, and the Windows system-prompt notes are generated from the detected shell (bash / PowerShell / cmd) instead of assuming Git Bash.

## 0.2.0

### Minor Changes

- [`dcf51dd`](https://github.com/MoonshotAI/kimi-code/commit/dcf51dd7947af9354da451f6eb2520347529959e) - Add a native-tools implementation, providing Rust-backed Read, Write, Edit, Grep, Glob, and Bash tools with automatic fallback to the TypeScript implementations. Enabled by default via the `KIMI_CODE_EXPERIMENTAL_NATIVE_TOOLS` flag; set `KIMI_CODE_EXPERIMENTAL_NATIVE_TOOLS=0` to opt out and use the TypeScript originals.

### Patch Changes

- [`c58880a`](https://github.com/MoonshotAI/kimi-code/commit/c58880a3fb76af21d6d4f2fbb30b1ee38a64a5e5) - Move native bash, grep, and structured grep execution to a background thread pool to avoid blocking the Node event loop, add an experimental flag for microtask-scheduled in-process RPC, remove redundant session-existence checks before prompt/skill/message operations, and parallelize per-agent state queries during session resume.
