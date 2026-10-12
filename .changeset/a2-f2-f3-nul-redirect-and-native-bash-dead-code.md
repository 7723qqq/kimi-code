---
"@moonshot-ai/agent-core-v2": patch
---

Only rewrite a Windows `nul` redirect when it really is one, and drop the unreachable native bash wrapper (a2/F2, a2/F3 of the 2026-10-12 audit).

**`nul` is rewritten per redirect, not per string** (`a2/F2`). On Windows the Bash tool replaced every `> nul` / `2> nul` / `&> nul` match in the raw command with `/dev/null`, with no idea which matches were redirect targets. A command that merely *mentions* the text, such as `grep -n "> nul" log.txt`, was silently rewritten to `grep -n "> /dev/null" log.txt`, and so was any `> nul` line inside a heredoc — the model got the result of a command it never wrote, and a miss looked like a genuine no-match. The rewrite is now a quote- and heredoc-aware scan: `> nul` is only rewritten when it sits outside single quotes, double quotes and heredoc bodies, and command substitutions (`$( … )`, backticks) are still rewritten inside. Behaviour note: a quoted `> nul` is now left as the literal text the caller typed, which is the point of the fix; there is no flag to restore the old whole-string behaviour.

**The unused native bash process wrapper is gone** (`a2/F3`). `NativeBashProcess` implemented `IProcess` on top of the Rust `nativeBashSpawn` channel, but nothing ever constructed it — `tryNativeBashSpawn`/`Wait`/`Kill`/`Dispose` had no callers, and `kill(_signal)` dropped the signal it was handed. It was a trap for whoever wired it up next: `ProcessTask`'s SIGTERM → grace → SIGKILL contract would have broken on arrival. The file and its four TypeScript wrappers are removed rather than wired up (the Rust exports stay in `@moonshot-ai/kimi-native-tools`), and the stale silent-catch baseline entry goes with them. No user-visible change — nothing reached this code.
