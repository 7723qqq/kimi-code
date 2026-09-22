# Data locations

Kimi Code CLI stores the config file, session history, login credentials, diagnostic logs, and other runtime data under `~/.kimi-code/`. This page helps you understand where each type of data lives, what it is for, and how to clean up or relocate it when needed.

## Data root directory

The default data root is `~/.kimi-code/`. The actual path varies by platform:

- macOS: `/Users/<name>/.kimi-code`
- Linux: `/home/<name>/.kimi-code`
- Windows: `C:\Users\<name>\.kimi-code`

If you need to move the data directory elsewhere (for example, to isolate configs for different projects with independent environments), set `KIMI_CODE_HOME`:

```sh
export KIMI_CODE_HOME="$HOME/.config/kimi-code"
```

Once set, **all** Kimi Code data lands under the new path: config, sessions, logs, OAuth credentials, Kimi-specific user Skills, global `AGENTS.md`, and more. For the full reference on `KIMI_CODE_HOME`, see [Environment variables](./env-vars.md).

::: tip Note

**Generic `.agents` resources** stay under the real OS home so they can be shared across tools. For example, user-level generic Skills remain at `~/.agents/skills/`, while Kimi-specific user Skills move with `KIMI_CODE_HOME` as `$KIMI_CODE_HOME/skills/`.
:::

## Directory layout

```
$KIMI_CODE_HOME  (default: ~/.kimi-code)
├── config.toml             # User configuration
├── tui.toml                # Terminal UI preferences (including auto-update toggle)
├── AGENTS.md               # Global Kimi-specific agent instructions (optional)
├── mcp.json                # User-level MCP server declarations (optional)
├── skills/                 # Kimi-specific user-level Skills (optional)
├── plugins/
│   └── <id>/               # Content of remotely installed plugins (registry in agent/sessions.db)
├── credentials/            # OAuth credentials (dir 0700, files 0600)
│   ├── <name>.json
│   └── mcp/
│       └── <key>-<suffix>.json
├── sessions/               # Session data (see below)
│   └── <sessionId>/
├── agent/
│   └── sessions.db         # App-scope engine store: plugin registry and subagent resume state (SQLite)
├── engine-state/
│   └── <workspace-key>/    # Engine-local state (under the OS user's ~/.kimi-code; does not move with KIMI_CODE_HOME)
│       ├── plans/          # Plan-mode plan files (<plan-id>.md)
│       └── state/
│           ├── todo.json / plan.json / goal.json / cron.json / task.json / turn.json
│           ├── tasks/<task_id>/output.log   # Background task output
│           └── checkpoints/<seq>.json       # State snapshot stack
├── bin/
│   ├── rg                  # managed ripgrep binary for Grep (rg.exe on Windows)
│   └── fd                  # managed fd binary for file references (fd.exe on Windows)
├── cache/                  # CLI cache (e.g. the model catalog snapshot)
├── logs/
│   └── kimi-code.log       # Global diagnostic log
├── updates/
│   ├── latest.json
│   ├── install.json
│   ├── install.lock
│   └── rollout.log
└── user-history/
    └── <md5(workDir)>.jsonl
```

## File descriptions

Each top-level file under the data root serves a specific purpose; most are managed automatically by the CLI:

- **`config.toml`**: the main runtime configuration file, storing user-level settings such as providers, models, and loop control. See [Configuration files](./config-files.md).
- **`tui.toml`**: terminal UI client preferences, including `[upgrade].auto_install` (auto-update, on by default). You can disable it in `/settings` or by manually setting `auto_install = false`.
- **`AGENTS.md`**: global Kimi-specific agent instructions. This file moves with `KIMI_CODE_HOME`; generic cross-tool instructions can still live under `~/.agents/AGENTS.md`.
- **`mcp.json`**: user-level MCP server declarations, merged with the project-local `.kimi-code/mcp.json` on startup. See [MCP](../customization/mcp.md).
- **`skills/`**: Kimi-specific user-level Skills. This directory moves with `KIMI_CODE_HOME`; generic cross-tool Skills can still live under `~/.agents/skills/`. See [Agent Skills](../customization/skills.md).
- **`plugins/<id>/`**: content directory for a remotely installed plugin. Installed records, enabled state, and MCP server capability state live in the plugin registry inside the app-scope engine store `agent/sessions.db`; there is no `installed.json` anymore. See [Plugins](../customization/plugins.md).
- **`credentials/`**: OAuth credential directory, with permissions `0o700` (directory) / `0o600` (files), readable and writable only by the current user. Managed provider credentials are stored as `credentials/<name>.json`; MCP server credentials are stored under `credentials/mcp/`. Credentials are written using an atomic flow (tmp → fsync → rename) to prevent corruption.

## Session data

Each session's data is stored under `sessions/<sessionId>/` (there is no `workDirKey` bucket layer and no top-level `session_index.jsonl` index anymore — the session list is maintained by the SDK). Inside each session directory:

- **`session-meta.json`**: session metadata including title, `lastPrompt`, creation/update timestamps, and `forkedFrom`.
- **`history.jsonl`**: the message history persisted by the SDK, used for session resumption.
- **`upcoming-goals.json`**: the TUI-only queue created by `/goal next <objective>`. It is not part of the agent conversation until a queued goal is promoted after the current goal completes.
- **`logs/kimi-code.log`**: diagnostic log for this session; only present when a diagnostic event occurs.

Engine-local state is bucketed by a digest of the workspace path under `~/.kimi-code/engine-state/<workspace-key>/` in the **OS user's home** (note: this tree does not move with `KIMI_CODE_HOME`; it always lives in the real user home):

- **`plans/<plan-id>.md`**: plan files written in Plan mode.
- **`state/todo.json` / `plan.json` / `goal.json` / `cron.json` / `task.json` / `turn.json`**: per-domain persistence (todos, plan, goals, scheduled tasks, background tasks, turns). Reloaded into the scheduler when the session is resumed with `kimi --session`. See [Scheduled tasks](../reference/tools.md#scheduled-tasks).
- **`state/tasks/<task_id>/output.log`**: background task output logs.
- **`state/checkpoints/<seq>.json`**: the state snapshot stack behind undo/redo.

The app-scope engine store `agent/sessions.db` (SQLite) holds the plugin registry and subagent resume state; when serving through `kimi web` or `kimi-agent --serve`, sessions and conversation history live in that kind of SQLite store as well (the standalone server defaults to `./.kimi-agent/sessions.db`, overridable with `--data-dir`).

## Built-in tool cache

The first time the `Grep` tool needs ripgrep, the CLI can automatically download `rg` and cache it at `bin/rg` (`bin/rg.exe` on Windows). File-reference completion in the terminal UI uses `fd`; the CLI downloads and caches it at `bin/fd` (`bin/fd.exe` on Windows) in the background when needed. Subsequent runs reuse the cached binaries. `rg` prefers the system `PATH` before the cache, while `fd` checks the managed cache before falling back to system `fd` / `fdfind`. Deleting the `bin/` directory triggers a fresh download on the next use.

## Logs and update state

- **`logs/kimi-code.log`** (global): records startup, login, export, and other cross-session events.
- **`<sessionDir>/logs/kimi-code.log`** (session-level): records diagnostic events within a single session.

When reporting a bug, prefer exporting the relevant session with `kimi export` (see [kimi command](../reference/kimi-command.md)); the session log is included in the export by default. Add `--no-include-global-log` if you do not want to share the global log.

The files under `updates/` (`latest.json`, `install.json`, `install.lock`, `rollout.log`) are maintained automatically by the auto-update mechanism and normally do not need manual editing. `rollout.log` records which staged-rollout case each update check hit, which helps explain when a device will receive a new release.

## Input history

Terminal input history is saved separately per working directory, at `user-history/<md5(workDir)>.jsonl`. It is used to browse previously typed prompts in the terminal UI using the arrow keys.

## Clearing data

Deleting the data root directory (`~/.kimi-code/` or the path set by `KIMI_CODE_HOME`) removes all runtime data. To clear only part of the data:

| Goal | Action |
| --- | --- |
| Reset configuration | Delete `~/.kimi-code/config.toml` |
| Reset terminal UI preferences | Delete `~/.kimi-code/tui.toml` |
| Clear all sessions | Delete `~/.kimi-code/sessions/` and `agent/sessions.db` |
| Clear diagnostic logs | Delete `~/.kimi-code/logs/` |
| Clear input history | Delete `~/.kimi-code/user-history/` |
| Reset update state | Delete `~/.kimi-code/updates/latest.json` |
| Force re-download of managed `rg` and `fd` | Delete `~/.kimi-code/bin/` |
| Clear provider OAuth login state | Run `/logout`, or delete the corresponding `credentials/<name>.json` |
| Clear MCP server OAuth login state | Delete `credentials/mcp/` (`/logout` does not clear MCP credentials) |
| Remove user-level MCP declarations | Delete `$KIMI_CODE_HOME/mcp.json` (default `~/.kimi-code/mcp.json`) |
| Clear global Kimi-specific agent instructions | Delete `$KIMI_CODE_HOME/AGENTS.md` (default `~/.kimi-code/AGENTS.md`) |
| Clear plugin install records | Delete `$KIMI_CODE_HOME/plugins/` (local plugin source directories are not affected) |
| Clear Kimi-specific user-level Skills | Delete `$KIMI_CODE_HOME/skills/` (default `~/.kimi-code/skills/`) |

## Next steps

- [Configuration files](./config-files.md) — full reference for `config.toml` fields
- [Environment variables](./env-vars.md) — detailed usage of `KIMI_CODE_HOME` and related path variables
