---
"@moonshot-ai/kimi-native-tools": minor
"@moonshot-ai/agent-core-v2": minor
"@moonshot-ai/kimi-code": minor
---

Make the Rust native engines the primary paths for Grep and Bash, with the TypeScript / ripgrep implementations demoted to fallbacks.

- Grep: the full native grep engine (`nativeGrep`) now runs first; ripgrep remains the fallback when the native module is unavailable. Native output uses absolute paths so workspace-relative display stays correct. Multiline searches keep using ripgrep (the native engine does not implement cross-line matching).
- Bash: a new native process-lifecycle API (`nativeBashSpawn` / `nativeBashWait` / `nativeBashKill` / `nativeBashDispose`) streams stdout/stderr in real time and kills the process tree on demand; the Bash tool spawns through it and falls back to the node-local spawn.
- Observability: a new `grep_tool_native` telemetry event tracks native usage, and the `/status` report shows `Native tools: rust / js (fallback)` so users can see which implementation is active.
