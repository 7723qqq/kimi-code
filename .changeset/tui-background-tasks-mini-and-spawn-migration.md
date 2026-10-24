---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kap-server": patch
---

The TUI gains a background-task mini panel: a docked view of the session's background tasks with a detail pane for the selected task's output, reachable without leaving the composer. The Claude CLI now spawns its provider child process through `Bun.spawn` instead of `node:child_process`, as do the environment probe, the shell-path bridge, the MCP OAuth store, the workflow runtime and the tower's git protocol, so process startup no longer pays for a Node compatibility layer.

A side question asked of an existing session now keeps the session's transient uploads until the turn settles rather than dropping them the moment the turn launches, so a running turn can still read the images it was given. A btw (side-question) agent that loses its scope to a restart gets its read-only tool veto attached again when the scope is recreated. `git diff` for an untracked file returns the added lines on Windows instead of an empty diff, where the POSIX `/dev/null` the command used was resolved as a directory.
